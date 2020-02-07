const net = require('net');
const ndjson = require('ndjson');
const assert = require('bsert');
const AsyncEmitter = require('bevent');
const miner = require('../');

class StratumClient extends AsyncEmitter {
  constructor(miner, options) {
    super();

    assert(miner);
    this.miner = miner;
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 3008;
    this.username = options.username || '';
    this.password = options.password || '';

    this.client = null;
    this.writer = null;

    this.jobid = '';
    this.maskHash = Buffer.alloc(32);
    this.mining = false;
    this.offset = 0;
  }

  log(...args) {
    console.log(...args);
  }

  error(...args) {
    console.error(...args);
  }

  start() {
    this.mining = true;
    this.client = new net.Socket();

    this.client.pipe(ndjson.parse()).on('data', async (data) => {
      console.log('data: ', data);

      if (data.method === 'mining.notify') {
        const jobid = data.params[0];
        const time = data.params[1];
        const header = Buffer.from(data.params[2], 'hex');
        const target = Buffer.from(data.params[3], 'hex');
        const height = data.params[4];
        const maskHash = Buffer.from(data.params[5], 'hex');

        const now = Math.floor(Date.now() / 1000);
        const offset = time - now;
        if (offset !== this.offset) {
          this.offset = offset;
          this.log('Time offset: %d', this.offset);
        }

        this.jobid = jobid;
        this.maskHash = maskHash;
        await this.work(jobid, header, target, height, maskHash);
      }

    });

    this.client.on('error', (err) => {
      console.error(err);
    });

    this.client.on('close', () => {
      console.log('Connection closed');
    });

    this.connect();
  }

  stop () {
    this.mining = false;
    this.client.destroy();
    this.writer.destroy();
  }

  now() {
    return Math.floor(Date.now() / 1000) + this.offset;
  }

  sendMethod(cmd) {
    this.writer.write(cmd);
  }

  connect() {
    this.writer = ndjson.serialize();
    this.writer.on('data', (line) => { this.client.write(line) });

    this.client.connect(this.port, this.host, () => {
      console.log('connected');

      this.sendMethod({
        id: 0,
        method: "mining.authorize",
        params: [this.username, this.password]
      });

      this.sendMethod({
        id: 1,
        method: "mining.subscribe",
        params: [],
      });
    });
  }

  async work(jobid, hdr, target, height, maskHash) {
    let nonce, extraNonce, valid;
    let i = 0;

    for (;;) {
      if (!this.mining || this.jobid != jobid)
        break;

      // Handle overflow
      i = i++ % 1000;

      const time = increment(hdr, this.now());

      if (i % 1e2 === 0) {
        this.log('Mining height %d (target=%s).',
          height, target.toString('hex'));
      }

      try {
        [nonce, extraNonce, valid] = await this.miner.mine(hdr, target);
      } catch (e) {
        this.error(e.stack);
        continue;
      }

      if (!valid)
        continue;

      if (!maskHash.equals(this.maskHash)) {
        this.log('New job. Switching.');
        break;
      }

      this.log('Found valid nonce: %d, extra nonce %s',
        nonce, extraNonce.toString('hex'));

      let reason = '';

      try {
        [valid, reason] = this.sendMethod({
          id: 1,
          method: "mining.submit",
          params: [this.username, jobid, extraNonce, time, nonce],
        });
      } catch (e) {
        this.error(e.stack);
      }

      if (!valid) {
        this.log('Invalid block submitted: %s.', this.miner.hashHeader(raw, 'hex'));
        this.log('Reason: %s', reason);
      }

      if (!maskHash.equals(this.maskHash)) {
        this.log('New job. Switching.');
        break;
      }
    }
  }
}

/*
 * Helpers
 */

function increment(hdr, now) {
  const time = readTime(hdr, 4);

  switch (miner.NETWORK) {
    case 'main':
    case 'regtest':
      if (now > time) {
        writeTime(hdr, now, 4);
        return now;
      }
      break;
  }

  // Increment the extra nonce.
  for (let i = miner.EXTRA_NONCE_START; i < miner.EXTRA_NONCE_END; i++) {
    if (hdr[i] !== 0xff) {
      hdr[i] += 1;
      break;
    }
    hdr[i] = 0;
  }

  return time;
}

function readTime(hdr, off) {
  assert(hdr.length >= off + 8);

  const lo = hdr.readUInt32LE(off);
  const hi = hdr.readUInt16LE(off + 4);

  assert(hdr.readUInt16LE(off + 6) === 0);

  return hi * 0x100000000 + lo;
}

function writeTime(hdr, time, off) {
  assert(hdr.length >= off + 8);
  assert(time >= 0 && time <= 0xffffffffffff);

  const lo = time >>> 0;
  const hi = (time * (1 / 0x100000000)) >>> 0;

  hdr.writeUInt32LE(lo, off);
  hdr.writeUInt16LE(hi, off + 4);
  hdr.writeUInt16LE(0, off + 6);
}

module.exports = StratumClient;

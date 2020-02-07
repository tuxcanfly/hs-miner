const net = require('net');
const ndjson = require('ndjson');
const AsyncEmitter = require('bevent');

class StratumClient extends AsyncEmitter {
  constructor(miner, options) {
    assert(miner);

    this.miner = miner;
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 3008;
    this.username = options.username || '';
    this.password = options.password || '';

    this.client = null;
    this.writer = null;
  }

  start() {
    this.client = new net.Socket();

    this.client.pipe(ndjson.parse()).on('data', function(data) {
      console.log('data: ', data);

      if (data.method === 'mining.notify') {
        const jobid = data.params[0];
        const header = data.params[1];
        const target = data.params[2];
        const height = data.params[3];
        const hash = data.params[4];
        this.emit('job', jobid, header, target, height, hash);
      }

    });

    this.client.on('error', function(err) {
      console.error(err);
    });

    this.client.on('close', function() {
      console.log('Connection closed');
    });

    this.connect();
  }

  stop () {
    this.client.destroy();
    this.writer.destroy();
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

  async work() {
    try {
      await this._work();
    } catch (e) {
      this.error(e.stack);
    }
  }

  async _work() {
    let nonce, extraNonce, valid;
    let i = 0;

    if (!this.mining)
      break;

    this.on('job', (jobid, hdr, target, height, maskHash) => {
      // Handle overflow
      i = i++ % 1000;

      const time = increment(this.miner, hdr, this.now());

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
        continue;
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
        continue;
      }
    });
  }
}

/*
 * Helpers
 */

function increment(miner, hdr, now) {
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

const request = require('brq');
const assert = require('bsert');

class RPCClient {
  constructor(miner, options) {
    assert(miner);

    this.miner = miner;
    this.ssl = options.ssl || false;
    this.host = options.host || 'localhost';
    this.port = options.port || getPort(this.miner);
    this.user = options.user || 'hns';
    this.pass = options.pass || '';
    this.sequence = 0;
    this.hdr = Buffer.alloc(this.miner.HDR_SIZE, 0x00);
    this.target = options.target || Buffer.alloc(32, 0xff);
    this.height = 0;
    this.mining = false;
    this.offset = 0;
    this.maskHash = Buffer.alloc(32, 0x00);
  }

  log(...args) {
    console.log(...args);
  }

  error(...args) {
    console.error(...args);
  }

  start() {
    this.timer = setInterval(() => this.poll(), 3000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.mining = false;
  }

  now() {
    return Math.floor(Date.now() / 1000) + this.offset;
  }

  async poll() {
    try {
      await this.repoll();
    } catch (e) {
      this.error(e.stack);
    }
  }

  async repoll() {
    const result = await this.getWork();

    if (!result)
      return;

    const {
      hdr,
      target,
      height,
      time,
      maskHash
    } = result;

    // Not new work.
    if (maskHash.equals(this.maskHash))
      return;

    const now = Math.floor(Date.now() / 1000);
    const offset = time - now;

    if (offset !== this.offset) {
      this.offset = offset;
      this.log('Time offset: %d', this.offset);
    }

    this.hdr = hdr;
    this.target = target;
    this.height = height;
    this.maskHash = maskHash;

    this.miner.stopAll();

    this.log('New job: %d', height);
    this.log('New target: %s', target.toString('hex'));
    this.log(readJSON(hdr));

    if (!this.mining) {
      this.mining = true;
      this.work();
    }
  }

  getJob() {
    return [this.hdr, this.target, this.height, this.maskHash];
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

    for (;;) {
      if (!this.mining)
        break;

      // Handle overflow
      i = i++ % 1000;
      const [hdr, target, height, maskHash] = this.getJob();

      increment(this.miner, hdr, this.now());

      if (i % 1e2 === 0) {
        this.log('Mining height %d (target=%s).',
          height, target.toString('hex'));
      }

      try {
        [nonce, extraNonce, valid] = await this.mine(hdr, target);
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

      const raw = this.toBlock(hdr, nonce, extraNonce);

      let reason = '';

      try {
        [valid, reason] = await this.submitWork(raw);
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

      await this.poll();
    }
  }

  async execute(method, params) {
    assert(typeof method === 'string');

    if (params == null)
      params = null;

    this.sequence += 1;

    const res = await request({
      method: 'POST',
      ssl: this.ssl,
      host: this.host,
      port: this.port,
      path: '/',
      username: this.user,
      password: this.pass,
      pool: true,
      json: {
        method: method,
        params: params,
        id: this.sequence
      }
    });

    if (res.statusCode === 401)
      throw new Error('Unauthorized (bad API key).');

    if (res.type !== 'json')
      throw new Error('Bad response (wrong content-type).');

    const json = res.json();

    if (!json)
      throw new Error('No body for JSON-RPC response.');

    if (json.error) {
      const {message, code} = json.error;
      throw new Error([message, code].join(' '));
    }

    if (res.statusCode !== 200)
      throw new Error(`Status code: ${res.statusCode}.`);

    return json.result;
  }

  async getWork() {
    const res = await this.execute('getwork', [this.maskHash.toString('hex')]);

    if (!res)
      return null;

    if (typeof res !== 'object')
      throw new Error('Non-object sent as getwork response.');

    if (res.network !== this.miner.NETWORK) {
      this.error('Wrong network: %s.', res.network);
      process.exit(1);
    }

    if (res.data.length !== this.miner.HDR_SIZE * 2)
      throw new Error('Bad header size.');

    const hdr = Buffer.from(res.data, 'hex');

    if (hdr.length !== this.miner.HDR_SIZE)
      throw new Error('Bad header size.');

    if (res.target.length !== 64)
      throw new Error('Bad target size.');

    const target = Buffer.from(res.target, 'hex');

    if (target.length !== 32)
      throw new Error('Bad target size.');

    const height = res.height;

    if ((height >>> 0) !== height)
      throw new Error('Bad height.');

    const time = res.time;

    if ((time >>> 0) !== time)
      throw new Error('Bad time.');

    const {maskHash} = readHeader(hdr);

    return {
      hdr,
      target,
      height,
      time,
      maskHash
    };
  }

  async submitWork(hdr) {
    this.log('Submitting work:');
    this.log(readJSON(hdr));

    const res = await this.execute('submitwork', [hdr.toString('hex')]);

    if (!Array.isArray(res))
      throw new Error('Non-array sent as submitwork response.');

    if (typeof res[0] !== 'boolean')
      throw new Error('Non-boolean sent as submitwork response.');

    if (typeof res[1] !== 'string')
      throw new Error('Non-string sent as submitwork response.');

    return res;
  }

  toBlock(hdr, nonce, extraNonce) {
    assert(hdr.length === this.miner.HDR_SIZE);
    hdr.writeUInt32LE(nonce, 0);
    extraNonce.copy(hdr, this.miner.EXTRA_NONCE_START);
    return hdr;
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
        return;
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

function getPort(miner) {
  switch (miner.NETWORK) {
    case 'main':
      return 12037;
    case 'testnet':
      return 13037;
    case 'regtest':
      return 14037;
    case 'simnet':
      return 15037;
    default:
      return 12037;
  }
}
module.exports = RPCClient;

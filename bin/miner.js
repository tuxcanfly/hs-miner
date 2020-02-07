'use strict';

const assert = require('assert');
const crypto = require('crypto');
const RPCClient = require('../lib/rpc');
const StratumClient = require('../lib/stratum');
const miner = require('../');

const EXTRA_NONCE = Buffer.alloc(miner.EXTRA_NONCE_SIZE);

class Miner {
  constructor(options) {
    this.backend = options.backend || miner.BACKEND;
    this.nonce = options.nonce || 0;
    this.range = options.range || 0;
    this.grids = options.grids || 0;
    this.blocks = options.blocks || 0;
    this.threads = options.threads || 0;
    this.device = options.device == null ? -1 : options.device;
    this.ssl = options.ssl || false;
    this.host = options.host || 'localhost';
    this.port = options.port || getPort();
    this.user = options.user || 'hns';
    this.pass = options.pass || '';
    this.protocol = options.protocol || 'solo';
    this.type = miner.getBackendDevice(this.backend);
    this.count = miner.getDeviceCount(this.type);
    this.sequence = 0;
    this.hdr = Buffer.alloc(miner.HDR_SIZE, 0x00);
    this.target = options.target || Buffer.alloc(32, 0xff);
    this.height = 0;
    this.mining = false;
    this.offset = 0;
    this.maskHash = Buffer.alloc(32, 0x00);

    if (this.protocol === 'solo')
      this.client = new RPCClient(miner, options);
    else if (this.protocol === 'stratum')
      this.client = new StratumClient(miner, options);
    else
      throw new Error(`Protocol ${this.protocol} not supported!`);
  }

  log(...args) {
    console.log(...args);
  }

  error(...args) {
    console.error(...args);
  }

  start() {
    if (!miner.hasBackend(this.backend))
      throw new Error(`Backend ${this.backend} not supported!`);

    this.log('Miner params:');
    this.log('  Network: %s', miner.NETWORK);
    this.log('  Device Type: %s', this.type);
    this.log('  Backend: %s', this.backend);

    const deviceids = [];
    for (let i = 0; i < this.count; i++)
      deviceids.push(i);
    this.log('  Using devices: ' + deviceids.join(','));

    const types = [];
    if (miner.getCPUCount() > 0)
      types.push('cpu');
    if (miner.HAS_CUDA)
      types.push('cuda');
    if (miner.HAS_OPENCL)
      types.push('opencl');

    this.log('  Supported Device Types: %s', types.join(','));
    this.log('');

    if (miner.HAS_CUDA) {
      console.log('CUDA Devices:');
      for (const {id, name, memory, bits, clock} of miner.getDevices('cuda'))
        console.log(`  ${id}: <${name}> ${memory} ${bits} ${clock}`);
    }

    if (miner.HAS_OPENCL) {
      console.log('OpenCL Devices:');
      for (const {id, name, memory, bits, clock} of miner.getDevices('opencl'))
        console.log(`  ${id}: <${name}> ${memory} ${bits} ${clock}`);
    }

    // We don't care about the CPUs if CUDA or OpenCL are installed.
    if (this.type === 'cpu') {
      console.log('CPUs:');
      for (const {id, name, memory, bits, clock} of miner.getCPUs())
        console.log(`  ${id}: <${name}> ${memory} ${bits} ${clock}`);
    }

    this.log('');
    this.log('Starting miner...');

    this.client.start();
  }

  stop () {
    this.client.stop();
  }

  /**
   * Create a mining job. The backend can choose
   * a strategy in searching through the nonce/extra
   * nonce space. Different backends may use different
   * arguments. Returns the nonce, extra nonce and a
   * bool that indicates if the job found a proof.
   *
   * `simple` uses nonce and range
   * `cuda` uses grids, blocks and threads
   *
   * @param {Number} index  - device index
   * @param {Buffer} hdr    - raw header
   * @param {Buffer} target - target (bytes)
   * @returns {Promise} [Number, Buffer, Boolean]
   */

  job(index, hdr, target) {
    return miner.mineAsync(hdr, {
      backend: this.backend,
      nonce: this.nonce,
      range: this.range,
      target,
      grids: this.grids,
      blocks: this.blocks,
      threads: this.threads,
      device: index
    });
  }

  async mine(hdr, target) {
    const jobs = [];

    // Use a single device if specified, otherwise use
    // all of the devices.
    if (this.device !== -1) {
      this.log('Using device: %d', this.device);
      randomize(hdr, miner.EXTRA_NONCE_END - 12, miner.EXTRA_NONCE_END);
      jobs.push(this.job(this.device, hdr, target));
    } else {
      for (let i = 0; i < this.count; i++) {
        randomize(hdr, miner.EXTRA_NONCE_END - 12, miner.EXTRA_NONCE_END);
        jobs.push(this.job(i, hdr, target));
      }
    }

    const result = await Promise.all(jobs);

    for (let i = 0; i < result.length; i++) {
      const [nonce, extraNonce, match] = result[i];

      if (match)
        return [nonce, extraNonce, true];
    }

    return [0, EXTRA_NONCE, false];
  }

  toBlock(hdr, nonce, extraNonce) {
    assert(hdr.length === miner.HDR_SIZE);
    hdr.writeUInt32LE(nonce, 0);
    extraNonce.copy(hdr, miner.EXTRA_NONCE_START);
    return hdr;
  }

  hashHeader(header) {
    return miner.hashHeader(header);
  }

  verify(header, target) {
    return miner.verify(header, target);
  }

  hasBackend(backend) {
    return miner.hasBackend(backend);
  }

  static getBackends() {
    return miner.getBackends();
  }

  static getCPUCount() {
    return miner.getCPUCount();
  }
}

/*
 * Helpers
 */

function randomize(hdr, start, end) {
  const random = crypto.randomBytes(end - start);
  random.copy(hdr, start);
}

function readHeader(hdr) {
  return {
    nonce: hdr.readUInt32LE(0),
    time: readTime(hdr, 4),
    padding: hdr.slice(12, 32),
    prevBlock: hdr.slice(32, 64),
    treeRoot: hdr.slice(64, 96),
    maskHash: hdr.slice(96, 128),
    extraNonce: hdr.slice(128, 152),
    reservedRoot: hdr.slice(152, 184),
    witnessRoot: hdr.slice(184, 216),
    merkleRoot: hdr.slice(216, 248),
    version: hdr.readUInt32LE(248),
    bits: hdr.readUInt32LE(252)
  };
}

function readJSON(hdr) {
  const json = {
    nonce: hdr.readUInt32LE(0),
    time: readTime(hdr, 4),
    padding: hdr.toString('hex', 12, 32),
    prevBlock: hdr.toString('hex', 32, 64),
    treeRoot: hdr.toString('hex', 64, 96),
    maskHash: hdr.toString('hex', 96, 128),
    extraNonce: hdr.toString('hex', 128, 152),
    reservedRoot: hdr.toString('hex', 152, 184),
    witnessRoot: hdr.toString('hex', 184, 216),
    merkleRoot: hdr.toString('hex', 216, 248),
    version: hdr.readUInt32LE(248),
    bits: hdr.readUInt32LE(252)
  };
  return JSON.stringify(json, null, 2);
}

function getPort() {
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

/*
 * Expose
 */

Miner.EXTRA_NONCE_SIZE = miner.EXTRA_NONCE_SIZE;
Miner.readHeader = readHeader;
Miner.readJSON = readJSON;
module.exports = Miner;

const net = require('net');
const ndjson = require('ndjson');

class StratumClient {
  constructor(options) {
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 3008;
    this.username = options.username || '';
    this.password = options.password || '';

    this.client = null;
    this.writer = null;
    this.init();
  }

  init() {
    this.client = new net.Socket();

    this.client.pipe(ndjson.parse()).on('data', function(data) {
      console.log('data: ', data);

      if (data.method === 'mining.notify') {
        const header = data.params[0];
      }

    });

    this.client.on('error', function(err) {
      console.error(err);
    });

    this.client.on('close', function() {
      console.log('Connection closed');
    });
  }

  send(cmd) {
    this.writer.write(cmd);
  }

  connect() {
    this.writer = ndjson.serialize();
    this.writer.on('data', (line) => { this.client.write(line) });

    this.client.connect(this.port, this.host, () => {
      console.log('connected');

      this.send({
        id: 0,
        method: "mining.authorize",
        params: [this.username, this.password]
      });

      this.send({
        id: 1,
        method: "mining.subscribe",
        params: [],
      });
    });
  }
}

module.exports = StratumClient;

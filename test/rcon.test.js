'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { Rcon } = require('../lib/rcon');

const packet = (id, type, body) => {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf;
};

// Minecraft splits replies into 4096-byte bodies, even inside a character.
test('rcon: joins fragments before decoding, so split characters survive', async () => {
  const reply = Buffer.from(`${'x'.repeat(4095)}ä${'y'.repeat(5000)} Grüße`, 'utf8');
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= buf.readInt32LE(0) + 4) {
        const len = buf.readInt32LE(0);
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        buf = buf.subarray(len + 4);
        if (type === 3) sock.write(packet(id, 2, ''));
        else for (let i = 0; i < reply.length; i += 4096) sock.write(packet(id, 0, reply.subarray(i, i + 4096)));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const rcon = new Rcon({ host: '127.0.0.1', port: server.address().port, password: 'x' });
  try {
    assert.strictEqual(await rcon.send('data get entity Alex Inventory'), reply.toString('utf8'));
  } finally {
    rcon.close();
    server.close();
  }
});

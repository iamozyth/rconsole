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
    sock.on('error', () => {}); // the client may hang up while the end-marker reply is still being written
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

test('vanilla: minecraft: commands past plugin overrides, plain names where unknown', async () => {
  const { Rcon } = require('../lib/rcon');
  const sent = [];
  const paper = Object.assign(Object.create(Rcon.prototype), { send: async (c) => (sent.push(c), c === 'minecraft:list' ? 'There are 0 of a max of 10 players online: ' : 'Essentials says hi') });
  assert.match(await paper.vanilla('list'), /of a max of 10/);
  const fabric = Object.assign(Object.create(Rcon.prototype), { send: async (c) => (sent.push(c), c.startsWith('minecraft:') ? 'Unknown or incomplete command, see below for error' : 'There are 1 of a max of 5 players online: Steve') });
  assert.match(await fabric.vanilla('list'), /Steve/);
  assert.match(await fabric.vanilla('list'), /Steve/);
  assert.deepStrictEqual(sent, ['minecraft:list', 'minecraft:list', 'list', 'list']);
});

// A reply of exactly 4096 bytes: done when the server answers the end
// marker, or after a short wait when it ignores unknown packet types.
for (const answersMarker of [true, false]) {
  test(`rcon: full-size reply ends ${answersMarker ? 'at the end marker' : 'after the fallback wait'}`, async () => {
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('error', () => {});
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 4 && buf.length >= buf.readInt32LE(0) + 4) {
          const len = buf.readInt32LE(0);
          const id = buf.readInt32LE(4);
          const type = buf.readInt32LE(8);
          buf = buf.subarray(len + 4);
          if (type === 3) sock.write(packet(id, 2, ''));
          else if (type === 2) sock.write(packet(id, 0, 'z'.repeat(4096)));
          else if (answersMarker) sock.write(packet(id, 0, `Unknown request ${type.toString(16)}`));
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const rcon = new Rcon({ host: '127.0.0.1', port: server.address().port, password: 'x' });
    try {
      assert.strictEqual(await rcon.send('first'), 'z'.repeat(4096));
      const t = Date.now();
      assert.strictEqual(await rcon.send('second'), 'z'.repeat(4096));
      const took = Date.now() - t;
      if (answersMarker) assert.ok(took < 100, `${took} ms`);
      else assert.ok(took >= 140, `${took} ms`);
      assert.strictEqual(await rcon.send('third'), 'z'.repeat(4096)); // late marker replies don't leak into the next command
    } finally {
      rcon.close();
      server.close();
    }
  });
}

test('rcon: while the server is unreachable, commands fail at once', async () => {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r)); // nothing listens there now
  const rcon = new Rcon({ host: '127.0.0.1', port, password: 'x' });
  await assert.rejects(rcon.send('list'));
  const t = Date.now();
  await assert.rejects(rcon.send('list'), /ECONNREFUSED|not reachable/);
  assert.ok(Date.now() - t < 50);
  rcon.close();
});

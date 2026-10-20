'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { ping, varint, readVarint } = require('../lib/slp');

test('slp: varints round-trip, -1 takes five bytes', () => {
  for (const n of [0, 1, 127, 128, 300, 25565, 2 ** 31 - 1]) assert.deepStrictEqual(readVarint(varint(n)), [n, varint(n).length]);
  assert.strictEqual(varint(-1).length, 5);
  assert.strictEqual(readVarint(Buffer.from([0x80])), null); // incomplete
});

test('slp: reads players and version from a status answer, split over packets', async () => {
  const server = net.createServer((sock) => {
    sock.once('data', () => {
      const json = Buffer.from(JSON.stringify({ version: { name: 'Paper 26.3' }, players: { online: 2, max: 10, sample: [{ name: 'Steve' }, { name: 'bad name!' }] } }));
      const body = Buffer.concat([varint(0), varint(json.length), json]);
      const all = Buffer.concat([varint(body.length), body]);
      sock.write(all.subarray(0, 5));
      setTimeout(() => sock.end(all.subarray(5)), 20);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const r = await ping({ port: server.address().port });
    assert.deepStrictEqual(r, { online: 2, max: 10, sample: ['Steve'], version: 'Paper 26.3' });
  } finally {
    server.close();
  }
});

test('slp: a closed port or a silent server fails fast', async () => {
  const silent = net.createServer(() => {}).listen(0, '127.0.0.1');
  await new Promise((r) => silent.once('listening', r));
  try {
    await assert.rejects(ping({ port: silent.address().port, timeoutMs: 200 }), /timed out/);
  } finally {
    silent.close();
  }
  await assert.rejects(ping({ port: 1, timeoutMs: 500 }));
});

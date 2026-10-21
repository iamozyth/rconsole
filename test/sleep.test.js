'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const slp = require('../lib/slp');
const { listen } = require('../lib/sleeplistener');
const { Sleeper, knownPlayers } = require('../lib/sleep');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-sleep-'));
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const str = (s) => Buffer.concat([slp.varint(Buffer.byteLength(s)), Buffer.from(s)]);
const packet = (...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([slp.varint(body.length), body]);
};

// What a client that joins gets back: the Disconnect text.
function join(port, name) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let buf = Buffer.alloc(0);
    sock.on('error', reject);
    sock.on('connect', () => {
      const p = Buffer.alloc(2);
      p.writeUInt16BE(port);
      sock.write(Buffer.concat([packet(slp.varint(0), slp.varint(775), str('localhost'), p, slp.varint(2)), packet(slp.varint(0), str(name), Buffer.alloc(16))]));
    });
    sock.on('data', (d) => (buf = Buffer.concat([buf, d])));
    sock.on('close', () => {
      const len = slp.readVarint(buf);
      const id = slp.readVarint(buf, len[1]);
      const s = slp.readVarint(buf, len[1] + id[1]);
      resolve({ id: id[0], text: JSON.parse(buf.toString('utf8', len[1] + id[1] + s[1], len[1] + id[1] + s[1] + s[0])) });
    });
  });
}

test('the listener shows a sleeping server and answers a join', async () => {
  const port = await freePort();
  const joined = [];
  const l = await listen({ port, host: '127.0.0.1', status: () => ({ motd: 'zzz', version: 'Sleeping', max: 8 }), onLogin: (name, ip) => (joined.push([name, ip]), { text: `hi ${name}` }) });
  const st = await slp.ping({ port });
  assert.deepStrictEqual([st.online, st.max, st.version], [0, 8, 'Sleeping']);
  const r = await join(port, 'Lena');
  assert.deepStrictEqual(r, { id: 0, text: { text: 'hi Lena' } });
  assert.deepStrictEqual(joined.map((j) => j[0]), ['Lena']);
  // Garbage is dropped without an answer.
  await new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => s.write(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f])));
    s.on('close', resolve);
    s.on('error', resolve);
  });
  await l.close();
  // The port is free again for the server.
  await new Promise((resolve, reject) => {
    const s = net.createServer().once('error', reject).listen(port, '127.0.0.1', () => s.close(resolve));
  });
});

function fakeServer({ port, players = 0 }) {
  const calls = [];
  const power = {
    active: 'active',
    async state() {
      return { available: true, active: this.active };
    },
    async run(action) {
      calls.push(action);
      if (action !== 'stop' && this.beforeStart) await this.beforeStart();
      this.active = action === 'stop' ? 'inactive' : 'active';
    },
    async waitFor() {},
  };
  const t = { key: 'survival', name: 'Survival', port, host: '127.0.0.1', power, busy: () => false, players: async () => t.online, known: (n) => n.toLowerCase() === 'lena', online: players };
  return { t, calls, power };
}

test('sleeps after the minutes without players, wakes for a known player', async () => {
  const port = await freePort();
  let now = Date.parse('2026-10-21T10:00:00Z');
  const { t, calls, power } = fakeServer({ port, players: 2 });
  const audit = [];
  const s = new Sleeper({ stateDir: tmp(), targets: async () => [t], now: () => now, audit: (e) => audit.push(e.action) });
  s.setConfig('survival', { enabled: true, minutes: 10 });
  await s.tick();
  assert.strictEqual(s.view('survival').emptySince, null, 'players online');
  t.online = 0;
  await s.tick();
  assert.ok(s.view('survival').sleepsAt);
  now += 9 * 60000;
  await s.tick();
  assert.deepStrictEqual(calls, [], 'not yet');
  now += 61000;
  await s.tick();
  assert.deepStrictEqual(calls, ['stop']);
  assert.ok(s.sleeping('survival'));
  assert.strictEqual((await slp.ping({ port })).version, 'Sleeping');

  const stranger = await join(port, 'Griefer');
  assert.match(stranger.text.text, /only its players can wake it/);
  assert.deepStrictEqual(calls, ['stop']);
  const r = await join(port, 'Lena');
  assert.match(r.text.text, /Waking Survival up for you, Lena/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepStrictEqual(calls, ['stop', 'start']);
  assert.strictEqual(s.sleeping('survival'), false);
  assert.strictEqual(s.view('survival').woken.by, 'Lena');
  assert.strictEqual(power.beforeStart, null);
  assert.deepStrictEqual(audit, ['server sleep', 'server wake']);
  await assert.rejects(slp.ping({ port, timeoutMs: 300 }), 'the port is the server\'s again');
  await s.stop();
});

test('a start from anywhere lets go of the port; switching it off too', async () => {
  const port = await freePort();
  let now = 0;
  const { t, power } = fakeServer({ port });
  const s = new Sleeper({ stateDir: tmp(), targets: async () => [t], now: () => now });
  s.setConfig('survival', { enabled: true, minutes: 5, wake: 'anyone' });
  await s.tick();
  now += 5 * 60000;
  await s.tick();
  assert.ok(s.sleeping('survival'));
  await power.run('start'); // the Start button, a scheduled restart
  assert.strictEqual(s.sleeping('survival'), false);
  await assert.rejects(slp.ping({ port, timeoutMs: 300 }));

  // Started outside rconsole (systemctl): the watcher notices.
  power.active = 'active';
  now += 5 * 60000;
  await s.tick();
  now += 5 * 60000;
  await s.tick();
  assert.ok(s.sleeping('survival'));
  power.active = 'activating';
  await s.watch();
  assert.strictEqual(s.sleeping('survival'), false);

  // Saved: a new instance knows the settings.
  const again = new Sleeper({ stateDir: path.dirname(s.file), targets: async () => [] });
  assert.deepStrictEqual([again.config('survival').enabled, again.config('survival').minutes, again.config('survival').wake], [true, 5, 'anyone']);
  assert.throws(() => s.setConfig('survival', { minutes: 7 }), /Minutes/);
  assert.throws(() => s.setConfig('survival', { wake: 'everyone' }), /wake/);
  await s.stop();
});

test('busy servers and unknown player counts stay awake', async () => {
  const port = await freePort();
  let now = 0;
  const { t, calls } = fakeServer({ port });
  const s = new Sleeper({ stateDir: tmp(), targets: async () => [t], now: () => now });
  s.setConfig('survival', { enabled: true, minutes: 5 });
  t.busy = () => true; // a backup, a countdown
  await s.tick();
  now += 6 * 60000;
  await s.tick();
  t.busy = () => false;
  t.players = async () => null; // no RCON, no status ping
  await s.tick();
  now += 6 * 60000;
  await s.tick();
  assert.deepStrictEqual(calls, []);
});

test('known players: whitelist and operators, or everyone who played', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'whitelist.json'), JSON.stringify([{ name: 'Lena' }]));
  fs.writeFileSync(path.join(dir, 'ops.json'), JSON.stringify([{ name: 'Masseo' }]));
  fs.writeFileSync(path.join(dir, 'usercache.json'), JSON.stringify([{ name: 'Alex' }]));
  assert.deepStrictEqual([...knownPlayers(dir, true)].sort(), ['lena', 'masseo']);
  assert.deepStrictEqual([...knownPlayers(dir, false)].sort(), ['alex', 'lena', 'masseo']);
});

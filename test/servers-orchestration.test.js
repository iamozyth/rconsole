'use strict';
// lib/servers.js with fake jobs and units: what rconsole does with the
// servers it installed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Servers } = require('../lib/servers');
const { Ops } = require('../lib/ops');

function setup({ active = 'inactive', autostart = false } = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rconsole-srv-'));
  const fifoDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rconsole-fifo-'));
  fs.mkdirSync(path.join(dir, 'survival'));
  const instance = { id: 'survival', distribution: 'paper', version: '26.3', build: 178, java: 25, memoryMb: 2048, port: 25565, flags: 'aikar', autostart, launch: { type: 'jar', path: 'p.jar' } };
  fs.writeFileSync(path.join(dir, 'survival', 'instance.json'), JSON.stringify(instance));
  fs.writeFileSync(path.join(dir, 'survival', 'server.properties'), 'enable-rcon=true\nrcon.port=25576\nrcon.password=secret\n');
  const calls = [];
  const state = { active };
  const power = {
    state: async () => ({ available: true, ...state }),
    run: async (a) => {
      calls.push(`power:${a}`);
      state.active = a === 'stop' ? 'inactive' : 'active';
    },
    waitFor: async () => calls.push('wait'),
  };
  const jobs = { run: async (kind, args) => (calls.push(`job:${kind}:${args.id}`), { ok: true, ...args }) };
  const servers = new Servers({ serversDir: dir, jobs, ops: new Ops({ log: () => {} }), log: () => {}, fifoDir, makePower: (unit) => (calls.push(`unit:${unit}`), power) });
  return { servers, calls, dir, fifoDir };
}
const done = (servers) => servers.ops.current;

test('list shows instances with their unit state, never the RCON password', async () => {
  const { servers } = setup({ active: 'active' });
  const [s] = await servers.list();
  assert.strictEqual(s.id, 'survival');
  assert.strictEqual(s.state.active, 'active');
  assert.ok(!JSON.stringify(s).includes('secret'));
});

test('create runs the helper job with the EULA acceptor, then starts', async () => {
  const { servers, calls } = setup();
  let args;
  servers.jobs.run = async (kind, a) => ((args = a), calls.push(`job:${kind}:${a.id}`), {});
  servers.create({ id: 'creative', distribution: 'fabric', version: '26.3', memoryMb: 4096, port: 25566, eula: true }, { user: 'masseo', start: true });
  await done(servers);
  assert.deepStrictEqual(calls, ['job:server-create:creative', 'unit:rconsole-mc@creative.service', 'power:start']);
  assert.strictEqual(args.eula.by, 'masseo');
  assert.strictEqual(args.java, undefined);
});

test('create refuses without the EULA, with bad fields, or a taken name', () => {
  const { servers } = setup();
  assert.throws(() => servers.create({ id: 'x', distribution: 'paper', version: '26.3', memoryMb: 1024, port: 25566 }, { user: 'u' }), /EULA/);
  assert.throws(() => servers.create({ id: 'X/../', distribution: 'paper', version: '26.3', memoryMb: 1024, port: 25566, eula: true }, { user: 'u' }), /id/);
  assert.throws(() => servers.create({ id: 'survival', distribution: 'paper', version: '26.3', memoryMb: 1024, port: 25566, eula: true }, { user: 'u' }), /already exists/);
});

test('delete stops a running server, waits, then archives and removes it', async () => {
  const { servers, calls } = setup({ active: 'active' });
  servers.remove('survival', { user: 'u' });
  await done(servers);
  assert.deepStrictEqual(calls.filter((c) => !c.startsWith('unit:')), ['power:stop', 'wait', 'job:server-delete:survival']);
});

test('power actions check the current state', async () => {
  const { servers, calls } = setup({ active: 'active' });
  await assert.rejects(servers.action('survival', 'start', { user: 'u' }), /already running/);
  await assert.rejects(servers.action('nope', 'start', { user: 'u' }), /No server/);
  await servers.action('survival', 'restart', { user: 'u' });
  await done(servers);
  assert.ok(calls.includes('power:restart'));
});

test('autostart starts only marked servers that are down', async () => {
  const marked = setup({ autostart: true });
  await marked.servers.autostart();
  assert.ok(marked.calls.includes('power:start'));
  const plain = setup();
  await plain.servers.autostart();
  assert.ok(!plain.calls.includes('power:start'));
});

test('console: refused while the server is stopped (systemd would start it for the line)', async () => {
  const { servers } = setup({ active: 'inactive' });
  await assert.rejects(servers.send('survival', 'say hi'), /not running/);
});

test('console: one line into the FIFO; refused when nothing reads it', async () => {
  const { servers, fifoDir } = setup({ active: 'active' });
  await assert.rejects(servers.send('survival', 'say hi'), /not running/);
  const fifo = path.join(fifoDir, 'rconsole-mc-survival.stdin');
  execFileSync('mkfifo', [fifo]);
  await assert.rejects(servers.send('survival', 'say hi'), /not running/); // no reader yet
  // A non-blocking read end stands in for the server.
  const reader = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  await servers.send('survival', '/say hi');
  const buf = Buffer.alloc(64);
  assert.strictEqual(buf.subarray(0, fs.readSync(reader, buf)).toString(), 'say hi\n');
  fs.closeSync(reader);
  await assert.rejects(servers.send('survival', 'say a\nop evil'), /one command line/);
});

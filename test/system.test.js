'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { SystemSettings, effective, readSaved } = require('../lib/system');
const { Listener } = require('../lib/listener');
const { Users } = require('../lib/auth');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-system-'));
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reachable = (port, host = '127.0.0.1') => new Promise((resolve) => {
  const s = net.connect(port, host, () => (s.destroy(), resolve(true)));
  s.on('error', () => resolve(false));
});

test('system: saved values win over the env file, reset brings it back', () => {
  const dir = tmp();
  const env = { WEB_PORT: '80', WEB_HOST: '0.0.0.0', TRUST_PROXY: '10.10.2.50', REQUIRE_2FA: 'admin', BACKUP_COMPRESSION: 'gzip' };
  const s = new SystemSettings({ stateDir: dir, env });
  assert.deepStrictEqual(s.values, { webHost: '0.0.0.0', webPort: 80, trustProxy: ['10.10.2.50'], require2fa: 'admin', metricsToken: '', backupKeep: 10, backupCompression: 'gzip', updateCheck: true });
  const n = s.next({ set: { webPort: '8080', trustProxy: '10.10.2.50, ::ffff:10.0.0.9, 10.10.2.50', backupCompression: 'auto' } });
  assert.deepStrictEqual(n.changed, ['webPort', 'trustProxy', 'backupCompression']);
  s.save(n.saved);
  assert.strictEqual(fs.statSync(path.join(dir, 'system.json')).mode & 0o777, 0o600);
  const again = new SystemSettings({ stateDir: dir, env });
  assert.strictEqual(again.values.webPort, 8080);
  assert.deepStrictEqual(again.values.trustProxy, ['10.10.2.50', '10.0.0.9']);
  const v = again.view();
  assert.deepStrictEqual([v.webPort.source, v.webPort.envValue, v.webHost.source, v.backupKeep.source], ['saved', 80, 'env', 'default']);
  again.save(again.next({ reset: ['webPort'] }).saved);
  assert.strictEqual(new SystemSettings({ stateDir: dir, env }).values.webPort, 80);
});

test('system: bad values are refused with a reason, hand-edited ones ignored', () => {
  const dir = tmp();
  const s = new SystemSettings({ stateDir: dir, env: {} });
  for (const [set, re] of [
    [{ webPort: 70000 }, /Port/],
    [{ webPort: '8o' }, /Port/],
    [{ webHost: 'example.com' }, /Address/],
    [{ trustProxy: '10.0.0.0/8' }, /not an IP/],
    [{ require2fa: 'yes' }, /Two-factor/],
    [{ metricsToken: 'short' }, /16 to 200/],
    [{ backupKeep: -1 }, /keep/],
    [{ updateCheck: 'no' }, /true or false/],
    [{ rconPassword: 'x' }, /Unknown setting/],
  ]) assert.throws(() => s.next({ set }), re, JSON.stringify(set));
  fs.writeFileSync(path.join(dir, 'system.json'), JSON.stringify({ webPort: 'nope', backupKeep: 3, mcDir: '/' }));
  assert.deepStrictEqual(readSaved(dir), { backupKeep: 3 });
  // config.js keeps working the way it did without a saved file.
  assert.strictEqual(effective({ WEB_PORT: 'x' }, {}).webPort, 8080);
  assert.strictEqual(effective({ SELF_UPDATE_CHECK: '0' }, {}).updateCheck, false);
});

function listenerWithConfirm() {
  let listener;
  const handler = (req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try {
        const r = listener.confirm(body, req.socket.server);
        res.end(JSON.stringify(r));
      } catch (e) {
        res.statusCode = e.status || 500;
        res.end(e.message);
      }
    });
  };
  listener = new Listener({ handler, trialMs: 400 });
  return listener;
}
const post = (port, token, host = '127.0.0.1') => fetch(`http://${host}:${port}/`, { method: 'POST', body: token }).then(async (r) => [r.status, await r.text()]);

test('listener: a new port is kept only when confirmed through it', async () => {
  const l = listenerWithConfirm();
  l.trialMs = 5000;
  const [a, b] = [await freePort(), await freePort()];
  await l.start('127.0.0.1', a);
  const t = await l.trial('127.0.0.1', b);
  assert.ok(await reachable(a) && (await reachable(b)), 'both listen during the trial');
  const [status, text] = await post(a, t.token);
  assert.strictEqual(status, 409, 'the old address cannot confirm');
  assert.match(text, /not the new/);
  assert.strictEqual((await post(b, 'wrong'))[0], 404);
  assert.strictEqual((await post(b, t.token))[0], 200);
  assert.deepStrictEqual([l.host, l.port, l.status()], ['127.0.0.1', b, null]);
  await sleep(1300);
  assert.strictEqual(await reachable(a), false, 'the old port closes');
  await l.close();
});

test('listener: an unconfirmed trial goes back on its own', async () => {
  const l = listenerWithConfirm();
  const [a, b] = [await freePort(), await freePort()];
  await l.start('127.0.0.1', a);
  await l.trial('127.0.0.1', b);
  await sleep(700);
  assert.strictEqual(l.status(), null);
  assert.strictEqual(await reachable(b), false);
  assert.ok(await reachable(a));
  assert.strictEqual(l.port, a);
  await l.close();
});

test('listener: same port on another address swaps, and swaps back', async () => {
  const l = listenerWithConfirm();
  const a = await freePort();
  await l.start('127.0.0.1', a);
  const t = await l.trial('0.0.0.0', a);
  assert.strictEqual(t.swap, true);
  assert.ok(await reachable(a), 'reachable on the new address');
  await l.cancel();
  assert.deepStrictEqual([l.host, l.port], ['127.0.0.1', a]);
  assert.ok(await reachable(a));
  await l.close();
});

test('listener: a port in use fails the trial and keeps the old one; a saved one falls back at start', async () => {
  const l = listenerWithConfirm();
  const [a, busy] = [await freePort(), await freePort()];
  const other = http.createServer().listen(busy, '127.0.0.1');
  await new Promise((r) => other.once('listening', r));
  await l.start('127.0.0.1', a);
  await assert.rejects(l.trial('127.0.0.1', busy), /already in use/);
  assert.ok(await reachable(a));
  await l.close();

  const m = listenerWithConfirm();
  await m.start('127.0.0.1', busy, { host: '127.0.0.1', port: a });
  assert.strictEqual(m.port, a);
  assert.match(m.fellBack.error, /in use/);
  await m.close();
  other.close();
});

// rconsole for real: temp dirs, no RCON server (the console shows it as down).
async function startRconsole(root, port, extraEnv = {}) {
  const [mc, state, bk, sv] = ['mc', 'state', 'bk', 'servers'].map((d) => path.join(root, d));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, STATE_DIR: state, MC_DIR: mc, BACKUP_DIR: bk, SERVERS_DIR: sv, RCON_PORT: '1', RCON_PASSWORD: 'x', WEB_HOST: '127.0.0.1', WEB_PORT: String(port), JOB_RUNNER: 'direct', MC_SERVICE: 'rconsole-test-none.service', SELF_UPDATE_CHECK: '0', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  child.output = () => out;
  return child;
}
const waitUp = async (port) => {
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
};

test('server: Settings → System changes apply live, a new port needs confirming, and survives a restart', { timeout: 60000 }, async () => {
  const root = tmp();
  const [mc, state] = [path.join(root, 'mc'), path.join(root, 'state')];
  for (const d of ['mc/logs', 'state', 'bk', 'servers']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(mc, 'server.properties'), 'level-name=world\n');
  fs.writeFileSync(path.join(mc, 'logs', 'latest.log'), '');
  const users = new Users(state);
  await users.setPassword('alice', 'password-1234');
  await users.setPassword('bob', 'password-1234');
  const [a, b] = [await freePort(), await freePort()];
  let child = await startRconsole(root, a);
  try {
    assert.ok(await waitUp(a), child.output());
    const base = `http://127.0.0.1:${a}`;
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username: 'alice', password: 'password-1234' }) });
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const api = async (method, url, body, at = base) => {
      const res = await fetch(`${at}${url}`, { method, headers: { cookie, origin: at, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return [res.status, await res.json()];
    };

    let [status, v] = await api('GET', '/api/system');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual([v.settings.webPort.value, v.settings.webPort.source, v.listening.port], [a, 'env', a]);

    // Metrics: on with a token, live.
    assert.strictEqual((await fetch(`${base}/metrics`)).status, 404);
    [status] = await api('PUT', '/api/system', { set: { metricsToken: 'abcdefghijklmnop1234' } });
    assert.strictEqual(status, 200);
    assert.strictEqual((await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer abcdefghijklmnop1234' } })).status, 200);
    [, v] = await api('GET', '/api/system');
    assert.deepStrictEqual(v.settings.metricsToken, { set: true, source: 'saved', envSet: false, env: 'METRICS_TOKEN' });
    assert.ok(!JSON.stringify(v).includes('abcdefghijklmnop1234'), 'the token is never sent back');

    // 2FA: refused for yourself without 2FA; warns about others.
    [status, v] = await api('PUT', '/api/system', { set: { require2fa: 'admin' } });
    assert.strictEqual(status, 400);
    assert.match(v.error, /your own account first/);

    // Trusted proxies apply live: X-Forwarded-For counts from a listed address only.
    [status] = await api('PUT', '/api/system', { set: { trustProxy: '127.0.0.1' } });
    assert.strictEqual(status, 200);
    // …and asks before dropping the proxy you're connected through.
    const viaProxy = await fetch(`${base}/api/system`, { method: 'PUT', headers: { cookie, origin: base, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' }, body: JSON.stringify({ set: { trustProxy: '' } }) });
    assert.strictEqual(viaProxy.status, 409);
    assert.strictEqual((await viaProxy.json()).confirm, 'proxy');

    // A bad port is refused before anything is saved.
    [status, v] = await api('PUT', '/api/system', { set: { webPort: 0, backupKeep: 3 } });
    assert.strictEqual(status, 400);
    [, v] = await api('GET', '/api/system');
    assert.strictEqual(v.settings.backupKeep.value, 10);

    // The new port: a trial next to the old one.
    [status, v] = await api('PUT', '/api/system', { set: { webPort: b, backupKeep: 3 } });
    assert.strictEqual(status, 200, JSON.stringify(v));
    assert.strictEqual(v.trial.port, b);
    assert.strictEqual(v.settings.backupKeep.value, 3, 'the rest is saved right away');
    assert.strictEqual(v.settings.webPort.value, a, 'the port is not saved yet');
    const token = v.trial.token;
    assert.strictEqual((await fetch(`http://127.0.0.1:${b}/confirm-address`)).status, 200, 'the confirm page needs no session');
    const confirm = (port) => fetch(`http://127.0.0.1:${port}/api/system/confirm`, { method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    const viaOld = await confirm(a);
    assert.strictEqual(viaOld.status, 409, await viaOld.text());
    const ok = await confirm(b);
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(await ok.json(), { ok: true, host: '127.0.0.1', port: b });
    await sleep(1300);
    assert.strictEqual(await reachable(a), false, 'the old port is closed');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(state, 'system.json'), 'utf8')).webPort, b);

    // Restart: the saved port wins over WEB_PORT.
    child.kill();
    await new Promise((r) => child.once('exit', r));
    child = await startRconsole(root, a);
    assert.ok(await waitUp(b), child.output());
    assert.strictEqual(await reachable(a), false);

    // A saved port that can't be opened falls back to the env file's.
    child.kill();
    await new Promise((r) => child.once('exit', r));
    const blocker = http.createServer().listen(b, '127.0.0.1');
    await new Promise((r) => blocker.once('listening', r));
    child = await startRconsole(root, a);
    assert.ok(await waitUp(a), child.output());
    assert.match(child.output(), /listening on 127\.0\.0\.1:\d+ from \/etc\/rconsole\.env instead/);
    blocker.close();

    // The CLI resets it.
    const cli = spawn(process.execPath, ['cli.js', 'system', 'reset', 'webPort'], { cwd: path.join(__dirname, '..'), env: { ...process.env, STATE_DIR: state } });
    await new Promise((r) => cli.once('exit', r));
    assert.ok(!('webPort' in JSON.parse(fs.readFileSync(path.join(state, 'system.json'), 'utf8'))));
  } finally {
    child.kill();
  }
});

'use strict';

// Sessions that survive a restart, recovery codes, REQUIRE_2FA and HSTS.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Users, Sessions, newTotpSecret, newRecoveryCodes, hotp } = require('../lib/auth');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

test('sessions: stored by digest, survive a reload, and removal sticks', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-sess-')), 'sessions.json');
  const a = new Sessions(file);
  const keep = a.create('alice');
  const drop = a.create('bob');
  a.destroy(drop);
  a.flush();
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(keep), 'token itself is not stored');
  assert.strictEqual((fs.statSync(file).mode & 0o777), 0o600);
  const b = new Sessions(file);
  assert.strictEqual(b.get(keep)?.user, 'alice');
  assert.strictEqual(b.get(drop), null);
});

test('recovery codes: each works once, only for its user', async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-rec-'));
  const users = new Users(state);
  await users.setPassword('alice', 'password-1234');
  await users.setPassword('bob', 'password-1234');
  const codes = newRecoveryCodes();
  assert.strictEqual(codes.length, 10);
  assert.strictEqual(new Set(codes).size, 10);
  users.setTotp('alice', newTotpSecret(), codes);
  assert.ok(!fs.readFileSync(path.join(state, 'users.json'), 'utf8').includes(codes[0]), 'stored hashed');
  assert.strictEqual(users.useRecovery('bob', codes[0]), false);
  assert.strictEqual(users.useRecovery('alice', codes[0].toLowerCase().replace('-', '')), true);
  assert.strictEqual(users.useRecovery('alice', codes[0]), false, 'used up');
  assert.strictEqual(users.useRecovery('alice', '123456'), false);
  assert.strictEqual(users.get('alice').recovery.length, 9);
  users.setTotp('alice', null);
  assert.strictEqual(users.get('alice').recovery, undefined);
});

test('server: REQUIRE_2FA, recovery code sign-in, HSTS, signed in across a restart', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-s2-'));
  const [mc, state, bk, sv] = ['mc', 'state', 'bk', 'servers'].map((d) => path.join(root, d));
  for (const d of [mc, state, bk, sv, path.join(mc, 'logs')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(mc, 'server.properties'), 'level-name=world\n');
  const users = new Users(state);
  await users.setPassword('alice', 'password-1234');
  await users.setPassword('mo', 'password-1234');
  users.setRole('mo', 'moderator');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, STATE_DIR: state, MC_DIR: mc, BACKUP_DIR: bk, SERVERS_DIR: sv, RCON_PORT: '1', RCON_PASSWORD: 'x', WEB_HOST: '127.0.0.1', WEB_PORT: String(port), JOB_RUNNER: 'direct', MC_SERVICE: 'rconsole-test-none.service', TRUST_PROXY: '127.0.0.1', SELF_UPDATE_CHECK: '0', REQUIRE_2FA: 'admin' };
  const start = async () => {
    const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return child;
  };
  const login = (username, code) => fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username, password: 'password-1234', code }) });
  let child = await start();
  try {
    // An admin without 2FA can't sign in; a moderator can.
    const denied = await login('alice');
    assert.strictEqual(denied.status, 403);
    assert.match((await denied.json()).error, /cli\.js user totp alice/);
    assert.strictEqual((await login('mo')).status, 200);

    const secret = newTotpSecret();
    const codes = newRecoveryCodes();
    users.setTotp('alice', secret, codes);
    assert.strictEqual((await login('alice')).status, 401); // asks for the code
    assert.strictEqual((await login('alice', 'AAAAA-AAAAA')).status, 401);
    const ok = await login('alice', codes[3]);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await login('alice', codes[3])).status, 401, 'a recovery code works once');
    assert.strictEqual((await login('alice', hotp(secret, Math.floor(Date.now() / 30000)))).status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];

    const plain = await fetch(`${base}/api/me`, { headers: { cookie } });
    assert.strictEqual(plain.headers.get('strict-transport-security'), null);
    const tls = await fetch(`${base}/api/me`, { headers: { cookie, 'x-forwarded-proto': 'https' } });
    assert.strictEqual(tls.headers.get('strict-transport-security'), 'max-age=31536000');

    // Restart: still signed in.
    await new Promise((r) => {
      child.on('exit', r);
      child.kill('SIGTERM');
    });
    child = await start();
    const me = await fetch(`${base}/api/me`, { headers: { cookie } });
    assert.strictEqual(me.status, 200);
    assert.strictEqual((await me.json()).user, 'alice');
  } finally {
    child.kill();
  }
});

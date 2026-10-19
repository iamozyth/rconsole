'use strict';

// The HTTP layer against hostile input: malformed requests, lockout
// attempts against someone else's account, and what viewers may see.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Users } = require('../lib/auth');
const { maskIps } = require('../lib/redact');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

// Raw request: fetch() refuses some of the malformed input sent here.
const raw = (port, lines) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(`${lines.join('\r\n')}\r\n\r\n`));
  let out = '';
  s.on('data', (d) => (out += d));
  s.on('end', () => resolve(out));
  s.on('error', () => resolve(out));
  s.setTimeout(3000, () => s.destroy());
});

test('redact: masks connection addresses, keeps times and paths', () => {
  assert.strictEqual(maskIps('Steve[/1.2.3.4:51234] logged in with entity id 5'), 'Steve[/•••] logged in with entity id 5');
  assert.strictEqual(maskIps('Steve[/0:0:0:0:0:0:0:1%0:51234] logged in'), 'Steve[/•••] logged in');
  assert.strictEqual(maskIps('GameProfile (/[2001:db8::1]:5555) lost connection'), 'GameProfile (/•••) lost connection');
  assert.strictEqual(maskIps('ban-ip 203.0.113.9'), 'ban-ip •••');
  assert.strictEqual(maskIps('[10:00:00] Loading /plugins/cafe.yml for 1.21.4'), '[10:00:00] Loading /plugins/cafe.yml for 1.21.4');
});

test('http: survives malformed requests, no lockout of other people, viewers see no addresses', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-http-'));
  const [mc, state, bk, sv] = ['mc', 'state', 'bk', 'servers'].map((d) => path.join(root, d));
  for (const d of [mc, state, bk, sv, path.join(mc, 'logs')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(mc, 'server.properties'), 'level-name=world\n');
  fs.writeFileSync(path.join(mc, 'logs', 'latest.log'), '[10:00:00] [Server thread/INFO]: Steve[/198.51.100.7:51234] logged in with entity id 5 at ([world]1, 2, 3)\n');
  fs.writeFileSync(path.join(mc, 'banned-ips.json'), JSON.stringify([{ ip: '198.51.100.8', created: '', source: 'x', expires: 'forever', reason: 'r' }]));
  const users = new Users(state);
  for (const [name, role] of [['alice', 'admin'], ['mo', 'moderator'], ['vic', 'viewer']]) {
    await users.setPassword(name, 'password-1234');
    if (role !== 'admin') users.setRole(name, role);
  }
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, STATE_DIR: state, MC_DIR: mc, BACKUP_DIR: bk, SERVERS_DIR: sv, RCON_PORT: '1', RCON_PASSWORD: 'x', WEB_HOST: '127.0.0.1', WEB_PORT: String(port), JOB_RUNNER: 'direct', MC_SERVICE: 'rconsole-test-none.service', TRUST_PROXY: '127.0.0.1', SELF_UPDATE_CHECK: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = false;
  child.on('exit', () => (exited = true));
  const base = `http://127.0.0.1:${port}`;
  const healthy = () => fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false);
  try {
    for (let i = 0; i < 100 && !(await healthy()); i++) await new Promise((r) => setTimeout(r, 100));

    // Malformed input gets an answer, and the process stays up.
    for (const cookie of ['a=%E0', 'rconsole_session=%', 'x=%zz; rconsole_session=%E0%A4%A']) {
      const r = await raw(port, ['GET /api/me HTTP/1.1', 'Host: x', `Cookie: ${cookie}`, 'Connection: close']);
      assert.match(r, /^HTTP\/1\.1 401/, cookie);
    }
    const login = async (username, password = 'password-1234', from = '10.0.0.1') => fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-forwarded-for': from }, body: JSON.stringify({ username, password }),
    });
    const cookieOf = (r) => r.headers.get('set-cookie').split(';')[0];
    const admin = cookieOf(await login('alice'));
    for (const p of ['/api/backups/%E0', '/api/plugins/%E0%A4/update', '/api/offsite/%']) {
      const method = p.startsWith('/api/backups') ? 'GET' : p.startsWith('/api/offsite') ? 'DELETE' : 'POST';
      const r = await fetch(`${base}${p}`, { method, headers: { cookie: admin, origin: base, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      assert.ok(r.status >= 400 && r.status < 500, `${p} → ${r.status}`);
    }
    assert.ok(await healthy(), 'still up');
    assert.strictEqual(exited, false);

    // Five wrong passwords from five addresses don't lock alice out…
    for (let i = 0; i < 6; i++) assert.strictEqual((await login('alice', 'wrong-password', `203.0.113.${i}`)).status, 401);
    assert.strictEqual((await login('alice', 'password-1234', '10.0.0.2')).status, 200);
    // …but one address that keeps guessing is.
    for (let i = 0; i < 5; i++) await login('mo', 'wrong-password', '203.0.113.50');
    assert.strictEqual((await login('mo', 'password-1234', '203.0.113.50')).status, 429);
    assert.strictEqual((await login('mo', 'password-1234', '10.0.0.3')).status, 200);

    // Addresses: masked for viewers, visible for moderators.
    const as = async (name) => cookieOf(await login(name, 'password-1234', '10.0.0.9'));
    const get = async (cookie, url) => (await fetch(`${base}${url}`, { headers: { cookie } })).text();
    const [vic, mo] = [await as('vic'), await as('mo')];
    assert.doesNotMatch(await get(vic, '/api/logs/search?q=logged'), /198\.51\.100\.7/);
    assert.match(await get(mo, '/api/logs/search?q=logged'), /198\.51\.100\.7/);
    assert.doesNotMatch(await get(vic, '/api/access'), /198\.51\.100\.8/);
    assert.match(await get(mo, '/api/access'), /198\.51\.100\.8/);
    const firstEvent = (cookie) => new Promise((resolve, reject) => {
      http.get(`${base}/api/logs`, { headers: { cookie } }, (res) => {
        let buf = '';
        res.on('data', (d) => {
          buf += d;
          if (buf.includes('\n\n')) {
            res.destroy();
            resolve(buf);
          }
        });
      }).on('error', reject);
    });
    assert.doesNotMatch(await firstEvent(vic), /198\.51\.100\.7/);
    assert.match(await firstEvent(mo), /198\.51\.100\.7/);

    // Static files: compressed, kept by the browser and revalidated by ETag.
    const css = await fetch(`${base}/style.css`, { headers: { 'accept-encoding': 'br, gzip' } });
    assert.strictEqual(css.headers.get('content-encoding'), 'br');
    assert.strictEqual(css.headers.get('cache-control'), 'no-cache');
    const etag = css.headers.get('etag');
    assert.match(etag, /^"[\w-]{16}"$/);
    assert.match(await css.text(), /:root/);
    assert.strictEqual((await fetch(`${base}/style.css`, { headers: { 'if-none-match': etag } })).status, 304);
    assert.strictEqual((await fetch(`${base}/app.js`, { headers: { cookie: admin, 'accept-encoding': 'gzip' } })).headers.get('content-encoding'), 'gzip');
    // Large API answers too; small ones aren't worth it.
    assert.strictEqual((await fetch(`${base}/api/me`, { headers: { cookie: admin, 'accept-encoding': 'gzip' } })).headers.get('content-encoding'), null);

    // Changing your own password: needs the current one, keeps this session,
    // ends the others.
    const other = cookieOf(await login('vic', 'password-1234', '10.0.0.20'));
    const change = (cookie, body) => fetch(`${base}/api/me/password`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.strictEqual((await change(vic, { current: 'wrong-password', password: 'brand-new-pass' })).status, 403);
    assert.strictEqual((await change(vic, { current: 'password-1234', password: 'short' })).status, 400);
    const ok = await change(vic, { current: 'password-1234', password: 'brand-new-pass' });
    assert.strictEqual(ok.status, 200);
    const fresh = cookieOf(ok);
    assert.strictEqual((await fetch(`${base}/api/me`, { headers: { cookie: fresh } })).status, 200);
    assert.strictEqual((await fetch(`${base}/api/me`, { headers: { cookie: other } })).status, 401);
    assert.strictEqual((await login('vic', 'brand-new-pass', '10.0.0.21')).status, 200);

  } finally {
    child.kill();
  }
});

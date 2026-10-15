'use strict';

// The map proxy: squaremap/BlueMap behind a per-session link, in a sandbox.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Users } = require('../lib/auth');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on('error', reject);
});

test('map: CSP names rconsole\'s origin (Safari), errors show inside the frame', { timeout: 60000 }, async () => {
  const mapPort = await freePort();
  const map = http.createServer((req, res) => {
    if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>squaremap</title>');
    if (req.url === '/tiles/settings.json') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"ui":{}}');
    res.writeHead(404).end();
  }).listen(mapPort, '127.0.0.1');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-map-'));
  const [mc, state, bk] = ['mc', 'state', 'bk'].map((d) => path.join(root, d));
  for (const d of [mc, state, bk, path.join(mc, 'logs')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(mc, 'server.properties'), 'level-name=world\n');
  fs.writeFileSync(path.join(mc, 'logs', 'latest.log'), '');
  await new Users(state).setPassword('admin', 'password-1234');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, STATE_DIR: state, MC_DIR: mc, BACKUP_DIR: bk, RCON_PORT: '1', RCON_PASSWORD: 'x', WEB_HOST: '127.0.0.1', WEB_PORT: String(port), JOB_RUNNER: 'direct', MC_SERVICE: 'rconsole-test-none.service', MAP_URL: `http://127.0.0.1:${mapPort}` },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username: 'admin', password: 'password-1234' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const { src } = await (await fetch(`${base}/api/map`, { headers: { cookie } })).json();

    const page = await get(port, src);
    assert.strictEqual(page.status, 200);
    const csp = page.headers['content-security-policy'];
    assert.match(csp, /^sandbox allow-scripts allow-popups;/);
    assert.match(csp, new RegExp(`connect-src 'self' http://127\\.0\\.0\\.1:${port};`));
    assert.match(csp, new RegExp(`frame-ancestors 'self' http://127\\.0\\.0\\.1:${port};`));
    const json = await get(port, `${src}tiles/settings.json`);
    assert.strictEqual(json.body, '{"ui":{}}');

    // A host header that could smuggle CSP falls back to 'self'.
    const forged = await get(port, src, { host: 'evil.example; script-src *' });
    assert.match(forged.headers['content-security-policy'], /connect-src 'self';/);

    // Expired link and unreachable map: a short page the frame may show.
    const expired = await get(port, '/map/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/');
    assert.match(expired.headers['content-type'], /text\/html/);
    assert.match(expired.headers['content-security-policy'], /frame-ancestors 'self' http:/);
    await new Promise((r) => map.close(r));
    const down = await get(port, src);
    assert.strictEqual(down.status, 502);
    assert.match(down.body, /can't reach the map server at http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\)/);
    assert.match(down.headers['content-security-policy'], /^sandbox; default-src 'none'/);
  } finally {
    child.kill();
    map.close();
  }
});

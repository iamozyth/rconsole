'use strict';
// World import over HTTP, against a running rconsole (helper run directly):
// who may upload, cross-site requests, chunks out of order, and a full
// upload → import → world list, with the audit log.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Users } = require('../lib/auth');
const { zip, worldEntries, levelDat } = require('./archives');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

test('http: upload a world in chunks and import it', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-import-http-'));
  const [mc, state, bk, sv] = ['mc', 'state', 'bk', 'servers'].map((d) => path.join(root, d));
  for (const d of [mc, state, bk, sv, path.join(mc, 'world')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(mc, 'server.properties'), 'level-name=world\n');
  fs.writeFileSync(path.join(mc, 'world', 'level.dat'), levelDat());
  const users = new Users(state);
  await users.setPassword('alice', 'password-1234');
  await users.setPassword('vic', 'password-1234');
  users.setRole('vic', 'viewer');
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, STATE_DIR: state, MC_DIR: mc, BACKUP_DIR: bk, SERVERS_DIR: sv, RCON_PORT: '1', RCON_PASSWORD: 'x', WEB_HOST: '127.0.0.1', WEB_PORT: String(port), JOB_RUNNER: 'direct', MC_SERVICE: 'rconsole-test-none.service', SELF_UPDATE_CHECK: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100 && !(await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 100));
    const login = async (username) => (await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username, password: 'password-1234' }),
    })).headers.get('set-cookie').split(';')[0];
    const [alice, vic] = [await login('alice'), await login('vic')];
    const call = (cookie, method, url, body, headers = {}) => fetch(`${base}${url}`, {
      method,
      headers: { cookie, origin: base, ...(Buffer.isBuffer(body) ? { 'content-type': 'application/octet-stream' } : body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined,
    });

    const file = zip([...worldEntries('Imported Survival', { version: '1.21.10' }), { name: 'Imported Survival/dimensions/minecraft/overworld/region/r.5.5.mca', data: Buffer.alloc(3 * 1024 * 1024, 9) }]);
    assert.strictEqual((await call(vic, 'POST', '/api/worlds/uploads', { name: 'w.zip', size: file.length })).status, 403);
    let r = await call(alice, 'POST', '/api/worlds/uploads', { name: 'Imported Survival.zip', size: file.length });
    assert.strictEqual(r.status, 201);
    const up = await r.json();
    assert.match(up.id, /^[a-f0-9]{32}$/);

    // Cross-site and form-style requests can't feed an upload.
    assert.strictEqual((await call(alice, 'PUT', `/api/worlds/uploads/${up.id}?offset=0`, file.subarray(0, 100), { origin: 'https://evil.example' })).status, 403);
    assert.strictEqual((await call(alice, 'PUT', `/api/worlds/uploads/${up.id}?offset=0`, file.subarray(0, 100), { 'content-type': 'text/plain' })).status, 415);
    assert.strictEqual((await call(vic, 'PUT', `/api/worlds/uploads/${up.id}?offset=0`, file.subarray(0, 100))).status, 403);

    // Importing before the upload is complete is refused.
    assert.strictEqual((await call(alice, 'POST', '/api/worlds/import', { upload: up.id, name: 'imported' })).status, 409);

    const chunk = 1024 * 1024;
    for (let off = 0; off < file.length; off += chunk) {
      r = await call(alice, 'PUT', `/api/worlds/uploads/${up.id}?offset=${off}`, file.subarray(off, off + chunk));
      assert.strictEqual(r.status, 200, await r.clone().text());
      if (off === chunk) {
        // A repeated chunk (the answer got lost) is refused with where to continue.
        const again = await call(alice, 'PUT', `/api/worlds/uploads/${up.id}?offset=${off}`, file.subarray(off, off + chunk));
        assert.strictEqual(again.status, 409);
      }
    }
    assert.deepStrictEqual(await (await call(alice, 'GET', `/api/worlds/uploads/${up.id}`)).json(), { id: up.id, name: 'Imported Survival.zip', size: file.length, received: file.length, complete: true, chunkSize: 16 * 1024 * 1024 });

    assert.strictEqual((await call(alice, 'POST', '/api/worlds/import', { upload: up.id, name: '../etc' })).status, 400);
    r = await call(alice, 'POST', '/api/worlds/import', { upload: up.id, name: 'imported' });
    assert.strictEqual(r.status, 202);
    let op;
    for (let i = 0; i < 100; i++) {
      op = (await (await call(alice, 'GET', '/api/worlds')).json()).op;
      if (!op.running) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.strictEqual(op.error, null);
    assert.strictEqual(op.result.from, 'Imported Survival');
    assert.strictEqual(op.result.version, '1.21.10');
    const { worlds } = await (await call(alice, 'GET', '/api/worlds')).json();
    const w = worlds.find((x) => x.name === 'imported');
    assert.deepStrictEqual(w.dimensions, ['overworld', 'nether', 'the_end']);
    assert.ok(w.size > 3 * 1024 * 1024);
    // The upload is gone once imported.
    assert.strictEqual((await call(alice, 'GET', `/api/worlds/uploads/${up.id}`)).status, 404);
    assert.deepStrictEqual(fs.readdirSync(path.join(bk, '.uploads')), []);

    // A second upload, cancelled.
    const second = await (await call(alice, 'POST', '/api/worlds/uploads', { name: 'x.zip', size: 1000 })).json();
    assert.strictEqual((await call(alice, 'DELETE', `/api/worlds/uploads/${second.id}`)).status, 200);
    assert.deepStrictEqual(fs.readdirSync(path.join(bk, '.uploads')), []);

    const audit = await (await call(alice, 'GET', '/api/audit?action=world')).json();
    const actions = (audit.entries || audit).map((e) => `${e.action}: ${e.target}`);
    assert.ok(actions.some((a) => /^world upload: Imported Survival\.zip \(\d+ KB\)$/.test(a)), actions.join('\n'));
    assert.ok(actions.some((a) => a === 'world import: imported'), actions.join('\n'));
  } finally {
    child.kill();
  }
});

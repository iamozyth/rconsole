'use strict';

// Starts rconsole for real (fake RCON, temp dirs) and checks what each role
// may do.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Users } = require('../lib/auth');

function fakeRcon() {
  const commands = [];
  const pkt = (id, type, body) => {
    const p = Buffer.from(body);
    const b = Buffer.alloc(14 + p.length);
    b.writeInt32LE(10 + p.length, 0);
    b.writeInt32LE(id, 4);
    b.writeInt32LE(type, 8);
    p.copy(b, 12);
    return b;
  };
  const server = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0);
        if (buf.length < len + 4) break;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.subarray(12, len + 2).toString();
        buf = buf.subarray(len + 4);
        if (type === 3) s.write(pkt(id, 2, ''));
        else {
          commands.push(body);
          s.write(pkt(id, 0, body === 'list' ? 'There are 0 of a max of 20 players online:' : `ok ${body}`));
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, commands, port: server.address().port })));
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

test('roles: admins can do everything, moderators moderate, viewers only read', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-roles-'));
  const [mc, state, bk, sv] = ['mc', 'state', 'bk', 'servers'].map((d) => path.join(root, d));
  for (const d of [mc, state, bk, sv, path.join(mc, 'logs')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(mc, 'server.properties'), 'level-name=world\nmotd=hi\n');
  fs.writeFileSync(path.join(mc, 'logs', 'latest.log'), '[10:00:00] [Server thread/INFO]: Done\n');
  const users = new Users(state);
  for (const [name, role] of [['alice', 'admin'], ['mo', 'moderator'], ['vic', 'viewer']]) {
    await users.setPassword(name, 'password-1234');
    if (role !== 'admin') users.setRole(name, role);
  }
  const rcon = await fakeRcon();
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, STATE_DIR: state, MC_DIR: mc, BACKUP_DIR: bk, SERVERS_DIR: sv, RCON_PORT: String(rcon.port), RCON_PASSWORD: 'x', WEB_HOST: '127.0.0.1', WEB_PORT: String(port), JOB_RUNNER: 'direct', MC_SERVICE: 'rconsole-test-none.service' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const login = async (username) => {
      const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username, password: 'password-1234' }) });
      assert.strictEqual(r.status, 200, `login ${username}`);
      return r.headers.get('set-cookie').split(';')[0];
    };
    const call = (cookie) => async (method, url, body) => (await fetch(`${base}${url}`, { method, headers: { cookie, origin: base, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).status;
    const as = { admin: call(await login('alice')), moderator: call(await login('mo')), viewer: call(await login('vic')) };

    const me = async (role) => (await fetch(`${base}/api/me`, { headers: { cookie: await login({ admin: 'alice', moderator: 'mo', viewer: 'vic' }[role]) } })).json();
    const mo = await me('moderator');
    assert.deepStrictEqual([mo.user, mo.role, mo.via], ['mo', 'moderator', 'password']);

    // [method, url, body, expected status for admin, moderator, viewer]; 2xx/4xx other than 403 count as allowed
    const cases = [
      ['GET', '/api/status', null, [true, true, true]],
      ['GET', '/api/settings', null, [true, true, true]],
      ['GET', '/api/players/history', null, [true, true, false]],
      ['GET', '/api/audit', null, [true, false, false]],
      ['GET', '/api/users', null, [true, false, false]],
      ['GET', '/api/about', null, [true, false, false]],
      ['GET', '/api/system', null, [true, false, false]],
      ['PUT', '/api/system', { set: { backupKeep: 5 } }, [true, false, false]],
      ['DELETE', '/api/system/trial', null, [true, false, false]],
      ['GET', '/api/notify', null, [true, false, false]],
      ['GET', '/api/offsite', null, [true, false, false]],
      ['POST', '/api/command', { command: 'kick Steve' }, [true, true, false]],
      ['POST', '/api/command', { command: 'say hello' }, [true, true, false]],
      ['POST', '/api/command', { command: 'op Steve' }, [true, false, false]],
      ['POST', '/api/command', { command: 'minecraft:stop' }, [true, false, false]],
      ['POST', '/api/command', { command: 'whitelist off' }, [true, false, false]],
      ['POST', '/api/command', { command: 'whitelist add Steve' }, [true, true, false]],
      ['POST', '/api/maintenance', { enabled: false }, [true, false, false]],
      ['POST', '/api/settings', { set: {} }, [true, false, false]],
      ['POST', '/api/backups', {}, [true, false, false]],
      ['PUT', '/api/offsite', {}, [true, false, false]],
      ['POST', '/api/problems/seen', null, [true, true, false]],
      ['GET', '/api/servers', null, [true, true, true]],
      ['POST', '/api/servers', { id: 'x' }, [true, false, false]],
      ['POST', '/api/servers/x/power', { action: 'start' }, [true, false, false]],
      ['POST', '/api/servers/x/console', { command: 'op Steve' }, [true, false, false]],
      ['DELETE', '/api/servers/x', null, [true, false, false]],
    ];
    for (const [method, url, body, allowed] of cases) {
      for (const [i, role] of ['admin', 'moderator', 'viewer'].entries()) {
        const status = await as[role](method, url, body);
        assert.strictEqual(status !== 403, allowed[i], `${role} ${method} ${url} ${body ? JSON.stringify(body) : ''} → ${status}`);
      }
    }
    assert.ok(!rcon.commands.includes('op Steve') || rcon.commands.filter((c) => c === 'op Steve').length === 1); // only the admin's
    assert.strictEqual(await as.viewer('POST', '/api/logout'), 200);

    // Changing a role signs the user out.
    users.setRole('mo', 'viewer');
    assert.strictEqual(await as.moderator('GET', '/api/status'), 401);
  } finally {
    child.kill();
    rcon.server.close();
  }
});

test('per-server roles: a role on one server, none on another; settings follow the account role', { timeout: 60000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-access-'));
  const [mc, state, bk, sv] = ['mc', 'state', 'bk', 'servers'].map((d) => path.join(root, d));
  for (const d of [mc, state, bk, sv, path.join(mc, 'logs'), path.join(sv, 'creative')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(mc, 'server.properties'), 'level-name=world\nmotd=hi\n');
  fs.writeFileSync(path.join(mc, 'logs', 'latest.log'), '[10:00:00] [Server thread/INFO]: Done\n');
  fs.writeFileSync(path.join(sv, 'creative', 'instance.json'), JSON.stringify({ id: 'creative', distribution: 'paper', version: '1.21.10', build: 120, java: 21, memoryMb: 1024, port: 25566, launch: { type: 'jar', path: 'paper.jar' } }));
  const users = new Users(state);
  for (const [name, role] of [['alice', 'admin'], ['sam', 'viewer'], ['nina', 'admin'], ['mo', 'moderator']]) {
    await users.setPassword(name, 'password-1234');
    if (role !== 'admin') users.setRole(name, role);
  }
  users.setServerRole('sam', '_attached', 'admin');
  users.setServerRole('sam', 'creative', 'none');
  users.setServerRole('nina', '_attached', 'none');
  users.setServerRole('mo', 'creative', 'admin');
  assert.strictEqual(users.highestRole('sam'), 'admin');
  const rcon = await fakeRcon();
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, STATE_DIR: state, MC_DIR: mc, BACKUP_DIR: bk, SERVERS_DIR: sv, RCON_PORT: String(rcon.port), RCON_PASSWORD: 'x', WEB_HOST: '127.0.0.1', WEB_PORT: String(port), JOB_RUNNER: 'direct', MC_SERVICE: 'rconsole-test-none.service' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const login = async (username) => {
      const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ username, password: 'password-1234' }) });
      assert.strictEqual(r.status, 200, `login ${username}`);
      return r.headers.get('set-cookie').split(';')[0];
    };
    const cookies = {};
    for (const n of ['alice', 'sam', 'nina', 'mo']) cookies[n] = await login(n);
    const req = async (who, method, url, body) => {
      const r = await fetch(`${base}${url}`, { method, headers: { cookie: cookies[who], origin: base, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const allowed = async (who, method, url, body) => (await req(who, method, url, body)).status !== 403;

    // sam: admin on the shown (attached) server, viewer for rconsole, no access to creative.
    const samMe = (await req('sam', 'GET', '/api/me')).body;
    assert.deepStrictEqual([samMe.role, samMe.globalRole, samMe.server.key], ['admin', 'viewer', '_attached']);
    assert.ok(await allowed('sam', 'POST', '/api/maintenance', { enabled: false }));
    assert.ok(await allowed('sam', 'POST', '/api/command', { command: 'op Steve' }));
    assert.ok(!(await allowed('sam', 'GET', '/api/users')));
    assert.ok(!(await allowed('sam', 'GET', '/api/system')));
    assert.ok(!(await allowed('sam', 'POST', '/api/servers', { id: 'x' })));
    assert.ok(!(await allowed('sam', 'POST', '/api/servers/creative/power', { action: 'start' })));
    assert.deepStrictEqual((await req('sam', 'GET', '/api/servers')).body.servers.map((s) => s.id), []);

    // nina: admin of rconsole, no access to the shown server.
    const st = await req('nina', 'GET', '/api/status');
    assert.strictEqual(st.status, 403);
    assert.ok(st.body.noAccess);
    assert.strictEqual((await req('nina', 'GET', '/api/me')).body.role, 'none');
    assert.ok(await allowed('nina', 'GET', '/api/users'));
    assert.ok(await allowed('nina', 'POST', '/api/servers/creative/power', { action: 'start' }));
    assert.strictEqual((await fetch(`${base}/api/logs`, { headers: { cookie: cookies.nina } })).status, 403);

    // mo: moderator here, admin on creative (may show it, start it, change it).
    assert.ok(!(await allowed('mo', 'POST', '/api/maintenance', { enabled: false })));
    assert.ok(await allowed('mo', 'POST', '/api/servers/creative/power', { action: 'start' }));
    assert.ok(await allowed('mo', 'PATCH', '/api/servers/creative', { memoryMb: 1024 }));
    assert.deepStrictEqual((await req('mo', 'GET', '/api/servers')).body.servers.map((s) => [s.id, s.myRole]), [['creative', 'admin']]);

    // Editing access: rconsole admins only, never your own, known servers only.
    assert.ok(!(await allowed('mo', 'PUT', '/api/users/sam/access', { servers: { creative: 'viewer' } })));
    assert.strictEqual((await req('alice', 'PUT', '/api/users/alice/access', { role: 'viewer' })).status, 409);
    assert.strictEqual((await req('alice', 'PUT', '/api/users/sam/access', { servers: { nope: 'admin' } })).status, 400);
    assert.strictEqual((await req('alice', 'PUT', '/api/users/sam/access', { servers: { creative: 'king' } })).status, 400);
    const saved = await req('alice', 'PUT', '/api/users/sam/access', { servers: { creative: 'viewer', _attached: null } });
    assert.strictEqual(saved.status, 200);
    assert.deepStrictEqual(saved.body.servers, { creative: 'viewer' });
    assert.ok(!(await allowed('sam', 'POST', '/api/maintenance', { enabled: false }))); // back to viewer here
    const list = (await req('alice', 'GET', '/api/users')).body;
    assert.deepStrictEqual(list.servers.map((x) => x.key), ['_attached', 'creative']);
    assert.deepStrictEqual(list.users.find((u) => u.name === 'sam').servers, { creative: 'viewer' });
    // A new account role signs the account out.
    assert.strictEqual((await req('alice', 'PUT', '/api/users/sam/access', { role: 'moderator' })).status, 200);
    assert.strictEqual((await req('sam', 'GET', '/api/me')).status, 401);
  } finally {
    child.kill();
    rcon.server.close();
  }
});

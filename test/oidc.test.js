'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Oidc, roleFor } = require('../lib/oidc');
const { Users } = require('../lib/auth');
const { fakeIdp } = require('./fake-idp');

// Plays the browser: begin, follow the provider's redirect, return what the
// callback would receive.
async function signIn(client, idp, { cookie } = {}) {
  const start = await client.begin();
  const r = await fetch(start.url, { redirect: 'manual' });
  const back = new URL(r.headers.get('location'));
  return client.finish({ code: back.searchParams.get('code'), state: back.searchParams.get('state'), cookie: cookie ?? start.cookie });
}

const GROUPS = { admin: ['rconsole-admins'], moderator: ['rconsole-moderators', 'mods'], viewer: ['rconsole-viewers'] };

test('oidc: roleFor picks the highest matching group', () => {
  assert.strictEqual(roleFor(['mods', 'rconsole-viewers'], GROUPS), 'moderator');
  assert.strictEqual(roleFor(['rconsole-admins', 'mods'], GROUPS), 'admin');
  assert.strictEqual(roleFor(['family'], GROUPS), null);
  assert.strictEqual(roleFor(undefined, GROUPS), null);
  assert.strictEqual(roleFor('rconsole-viewers', GROUPS), 'viewer');
});

test('oidc: sign-in with PKCE; RS256, PS256 and ES256 tokens verify', async () => {
  const idp = await fakeIdp();
  try {
    const client = new Oidc({ issuer: idp.issuer, clientId: 'rconsole', clientSecret: 'idp-secret', redirectUri: 'http://127.0.0.1:1/auth/oidc/callback' });
    for (const alg of ['RS256', 'PS256', 'ES256']) {
      idp.alg = alg;
      const { claims, groups } = await signIn(client, idp);
      assert.strictEqual(claims.sub, 'u-1', alg);
      assert.deepStrictEqual(groups, ['rconsole-admins']);
    }
    const last = idp.tokenRequests.at(-1);
    assert.strictEqual(last.grant_type, 'authorization_code');
    assert.ok(last.code_verifier.length >= 43);
  } finally {
    await idp.close();
  }
});

test('oidc: tampered, foreign, expired and unsigned tokens are refused', async () => {
  const idp = await fakeIdp();
  try {
    const client = new Oidc({ issuer: idp.issuer, clientId: 'rconsole', clientSecret: 'idp-secret', redirectUri: 'http://127.0.0.1:1/cb' });
    const cases = [
      [{ alg: 'none' }, /algorithm none is not accepted/],
      [{ alg: 'HS256' }, /algorithm HS256 is not accepted/],
      [{ badSig: true }, /signature is invalid/],
      [{ aud: 'someone-else' }, /another client/],
      [{ iss: 'https://evil.example/' }, /issuer/],
      [{ expired: true }, /expired/],
      [{ nonce: 'replayed' }, /nonce/],
      [{ kid: 'nope' }, /No signing key/],
    ];
    for (const [tamper, re] of cases) {
      idp.tamper = tamper;
      await assert.rejects(signIn(client, idp), re, JSON.stringify(tamper));
    }
  } finally {
    await idp.close();
  }
});

test('oidc: state is single-use and bound to the browser', async () => {
  const idp = await fakeIdp();
  try {
    const client = new Oidc({ issuer: idp.issuer, clientId: 'rconsole', clientSecret: 'idp-secret', redirectUri: 'http://127.0.0.1:1/cb' });
    // Another browser's cookie (login CSRF): refused.
    await assert.rejects(signIn(client, idp, { cookie: 'someone-elses-cookie' }), (e) => e.code === 'state');
    // Replaying the same state: refused the second time.
    const start = await client.begin();
    const back = new URL((await fetch(start.url, { redirect: 'manual' })).headers.get('location'));
    const args = { code: back.searchParams.get('code'), state: back.searchParams.get('state'), cookie: start.cookie };
    await client.finish(args);
    await assert.rejects(client.finish(args), (e) => e.code === 'state');
    await assert.rejects(client.finish({ code: 'x', state: 'made-up', cookie: 'x' }), (e) => e.code === 'state');
  } finally {
    await idp.close();
  }
});

test('oidc: a flood of sign-in starts doesn\'t push out anyone\'s pending sign-in', async () => {
  const idp = await fakeIdp();
  try {
    const client = new Oidc({ issuer: idp.issuer, clientId: 'rconsole', clientSecret: 'idp-secret', redirectUri: 'http://127.0.0.1:1/cb' });
    const victim = await client.begin();
    for (let i = 0; i < 500; i++) await client.begin(); // an attacker hammering /auth/oidc/start
    const back = new URL((await fetch(victim.url, { redirect: 'manual' })).headers.get('location'));
    const { claims } = await client.finish({ code: back.searchParams.get('code'), state: back.searchParams.get('state'), cookie: victim.cookie });
    assert.strictEqual(claims.sub, 'u-1');
    // A cookie signed by another rconsole (or edited) is worthless.
    const other = new Oidc({ issuer: idp.issuer, clientId: 'rconsole', clientSecret: 'idp-secret', redirectUri: 'http://127.0.0.1:1/cb' });
    const start = await other.begin();
    const back2 = new URL((await fetch(start.url, { redirect: 'manual' })).headers.get('location'));
    await assert.rejects(client.finish({ code: back2.searchParams.get('code'), state: back2.searchParams.get('state'), cookie: start.cookie }), (e) => e.code === 'state');
  } finally {
    await idp.close();
  }
});

test('oidc: a rotated signing key is fetched once; groups come from userinfo when missing', async () => {
  let clock = Date.now();
  const idp = await fakeIdp();
  try {
    const client = new Oidc({ issuer: idp.issuer, clientId: 'rconsole', clientSecret: 'idp-secret', redirectUri: 'http://127.0.0.1:1/cb', now: () => clock });
    await signIn(client, idp);
    const fetches = idp.jwksFetches;
    idp.publishRotated = true;
    idp.tamper = { kid: 'rsa-2' };
    clock += 2 * 60 * 1000; // past the refetch pause
    await signIn(client, idp);
    assert.strictEqual(idp.jwksFetches, fetches + 1);

    idp.tamper = {};
    idp.groupsInIdToken = false;
    idp.user.groups = ['rconsole-viewers'];
    const { groups } = await signIn(client, idp);
    assert.deepStrictEqual(groups, ['rconsole-viewers']);
  } finally {
    await idp.close();
  }
});

test('oidc: http:// is only accepted for the local machine', () => {
  assert.throws(() => new Oidc({ issuer: 'http://auth.example.com/', clientId: 'x', clientSecret: 'y' }), /must use https/);
  assert.ok(new Oidc({ issuer: 'https://auth.example.com/application/o/rconsole/', clientId: 'x', clientSecret: 'y' }));
});

test('users: SSO accounts never take over local ones and have no password', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-sso-users-'));
  const users = new Users(dir);
  await users.setPassword('admin', 'password-1234');
  const a = users.upsertSso({ iss: 'https://idp/', sub: '1', username: 'admin', role: 'viewer' });
  assert.strictEqual(a, 'admin-2');
  assert.strictEqual(users.get('admin').sso, undefined);
  assert.strictEqual(users.upsertSso({ iss: 'https://idp/', sub: '1', username: 'renamed', role: 'viewer' }), 'admin-2'); // same subject, same account
  assert.strictEqual(users.upsertSso({ iss: 'https://other/', sub: '1', username: 'admin', role: 'viewer' }), 'admin-3');
  await assert.rejects(users.setPassword('admin-2', 'password-1234'), /single sign-on/);
  const changed = users.get('admin-2').changed;
  users.upsertSso({ iss: 'https://idp/', sub: '1', username: 'admin', role: 'viewer' });
  assert.strictEqual(users.get('admin-2').changed, changed); // same role: sessions stay
  users.upsertSso({ iss: 'https://idp/', sub: '1', username: 'admin', role: 'admin' });
  assert.notStrictEqual(users.get('admin-2').changed, changed); // new role: old sessions end
  assert.strictEqual(users.upsertSso({ iss: 'https://idp/', sub: '9', email: 'Jo.Doe+x@example.com', role: 'viewer' }), 'jo.doe-x');
});

// The whole flow through rconsole: start → provider → callback → session.
const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

async function startServer(env) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-sso-'));
  const [mc, state, bk] = ['mc', 'state', 'bk'].map((d) => path.join(root, d));
  for (const d of [mc, state, bk, path.join(mc, 'logs')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(mc, 'server.properties'), 'level-name=world\n');
  fs.writeFileSync(path.join(mc, 'logs', 'latest.log'), '');
  await new Users(state).setPassword('masseo', 'password-1234'); // a local account with the same name as the SSO user
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, STATE_DIR: state, MC_DIR: mc, BACKUP_DIR: bk, RCON_PORT: '1', RCON_PASSWORD: 'x', WEB_HOST: '127.0.0.1', WEB_PORT: String(port), JOB_RUNNER: 'direct', MC_SERVICE: 'rconsole-test-none.service', PUBLIC_URL: base, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { base, state, child, log: () => out, stop: () => child.kill() };
}

// Follows start → provider → callback like a browser and returns the
// callback response plus the session cookie it set.
async function browserSignIn(base) {
  const start = await fetch(`${base}/auth/oidc/start`, { redirect: 'manual' });
  assert.strictEqual(start.status, 302);
  const oidcCookie = start.headers.get('set-cookie').split(';')[0];
  assert.match(start.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const atIdp = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const cb = await fetch(atIdp.headers.get('location'), { redirect: 'manual', headers: { cookie: oidcCookie } });
  const session = (cb.headers.getSetCookie?.() || [cb.headers.get('set-cookie')]).map((c) => c.split(';')[0]).find((c) => c.startsWith('rconsole_session=') && c.length > 20);
  return { cb, session };
}

test('sso: through rconsole, roles from groups, denied without one, local fallback', { timeout: 60000 }, async () => {
  const idp = await fakeIdp();
  const srv = await startServer({ OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'rconsole', OIDC_CLIENT_SECRET: 'idp-secret', OIDC_NAME: 'authentik', OIDC_MODERATOR_GROUPS: 'rconsole-moderators,mods' });
  try {
    assert.deepStrictEqual(await (await fetch(`${srv.base}/api/auth-config`)).json(), { sso: { name: 'authentik' }, local: true });

    const { cb, session } = await browserSignIn(srv.base);
    assert.strictEqual(cb.status, 200); // a page, so the Strict session cookie is sent on the way to /
    assert.match(await cb.text(), /http-equiv="refresh" content="0;url=\/"/);
    assert.ok(session, 'session cookie');
    const me = await (await fetch(`${srv.base}/api/me`, { headers: { cookie: session } })).json();
    assert.deepStrictEqual([me.user, me.role, me.via, me.name], ['masseo-2', 'admin', 'sso', 'Masseo']); // the local "masseo" is untouched

    // The local account still signs in with its password.
    const local = await fetch(`${srv.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: srv.base }, body: JSON.stringify({ username: 'masseo', password: 'password-1234' }) });
    assert.strictEqual(local.status, 200);
    // The SSO account has no password to guess.
    const sso = await fetch(`${srv.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: srv.base }, body: JSON.stringify({ username: 'masseo-2', password: 'password-1234' }) });
    assert.strictEqual(sso.status, 401);

    // Moved to a moderator group at the provider: the next sign-in changes the role and ends the admin session.
    idp.user.groups = ['mods'];
    const again = await browserSignIn(srv.base);
    const me2 = await (await fetch(`${srv.base}/api/me`, { headers: { cookie: again.session } })).json();
    assert.strictEqual(me2.role, 'moderator');
    assert.strictEqual((await fetch(`${srv.base}/api/me`, { headers: { cookie: session } })).status, 401);

    // No rconsole group: refused, no account created.
    idp.user = { sub: 'u-2', preferred_username: 'stranger', groups: ['family'] };
    const denied = await browserSignIn(srv.base);
    assert.strictEqual(denied.cb.status, 302);
    assert.strictEqual(denied.cb.headers.get('location'), '/login?error=sso_denied');
    assert.strictEqual(new Users(srv.state).get('stranger'), null);

    // A callback without the browser cookie (login CSRF) is refused.
    idp.user = { sub: 'u-1', preferred_username: 'masseo', groups: ['rconsole-admins'] };
    const start = await fetch(`${srv.base}/auth/oidc/start`, { redirect: 'manual' });
    const atIdp = await fetch(start.headers.get('location'), { redirect: 'manual' });
    const forged = await fetch(atIdp.headers.get('location'), { redirect: 'manual' });
    assert.strictEqual(forged.headers.get('location'), '/login?error=sso_state');
    // Stale or foreign callbacks (back button, two tabs, forgeries) don't lock this address out.
    for (let i = 0; i < 6; i++) await fetch(atIdp.headers.get('location'), { redirect: 'manual' });
    const fresh = await browserSignIn(srv.base); // back to admin: this also ends the moderator session above
    assert.ok(fresh.session, 'SSO still works');
    const pw = await fetch(`${srv.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: srv.base }, body: JSON.stringify({ username: 'masseo', password: 'password-1234' }) });
    assert.strictEqual(pw.status, 200, 'password login still works');

    // Signing out of an SSO session also ends the provider session.
    const out = await (await fetch(`${srv.base}/api/logout`, { method: 'POST', headers: { cookie: fresh.session, origin: srv.base } })).json();
    assert.ok(out.redirect.startsWith(`${idp.origin}/end-session?id_token_hint=`));
    assert.match(out.redirect, /post_logout_redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Flogin/);
  } finally {
    srv.stop();
    await idp.close();
  }
});

test('sso: LOCAL_LOGIN=off leaves only single sign-on', { timeout: 60000 }, async () => {
  const idp = await fakeIdp();
  const srv = await startServer({ OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'rconsole', OIDC_CLIENT_SECRET: 'idp-secret', LOCAL_LOGIN: 'off' });
  try {
    assert.deepStrictEqual(await (await fetch(`${srv.base}/api/auth-config`)).json(), { sso: { name: 'SSO' }, local: false });
    const r = await fetch(`${srv.base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: srv.base }, body: JSON.stringify({ username: 'masseo', password: 'password-1234' }) });
    assert.strictEqual(r.status, 403);
    assert.ok((await browserSignIn(srv.base)).session);
  } finally {
    srv.stop();
    await idp.close();
  }
});

test('sso: incomplete settings leave it off with a clear log line', { timeout: 60000 }, async () => {
  const srv = await startServer({ OIDC_ISSUER: 'https://auth.example.com/application/o/rconsole/', OIDC_CLIENT_ID: 'rconsole' });
  try {
    assert.deepStrictEqual(await (await fetch(`${srv.base}/api/auth-config`)).json(), { sso: null, local: true });
    assert.match(srv.log(), /sso: off, missing OIDC_CLIENT_SECRET/);
    assert.strictEqual((await fetch(`${srv.base}/auth/oidc/start`, { redirect: 'manual' })).headers.get('location'), '/login?error=sso_off');
  } finally {
    srv.stop();
  }
});

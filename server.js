#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./lib/config');
const { Rcon } = require('./lib/rcon');
const { LogTail } = require('./lib/logtail');
const { Stats } = require('./lib/stats');
const { readAccess } = require('./lib/access');
const { Backups } = require('./lib/backups');
const { Scheduler, Countdown } = require('./lib/scheduler');
const { Jobs } = require('./lib/jobs');
const { Updates } = require('./lib/updates');
const { Power } = require('./lib/power');
const { Ops } = require('./lib/ops');
const { Servers } = require('./lib/servers');
const active = require('./lib/active');
const distributions = require('./lib/distributions');
const { Worlds } = require('./lib/worlds');
const { Maintenance } = require('./lib/maintenance');
const { readProperties } = require('./lib/access');
const { Pending } = require('./lib/pending');
const { Plugins } = require('./lib/plugins');
const platformLib = require('./lib/platform');
const settingsSchema = require('./lib/settings');
const { Audit, summarize } = require('./lib/audit');
const { Metrics } = require('./lib/metrics');
const { PlayerHistory } = require('./lib/players');
const { searchLogs } = require('./lib/logsearch');
const { Scanners } = require('./lib/scanners');
const { Problems } = require('./lib/problems');
const hostcheck = require('./lib/hostcheck');
const mapDetect = require('./lib/mapdetect');
const instances = require('./lib/instances');
const { Offsite } = require('./lib/offsite');
const { Spark } = require('./lib/spark');
const { PlayerInfo } = require('./lib/playerinfo');
const { Configs, MAX_BYTES: CONFIG_MAX } = require('./lib/configs');
const { CommandCatalog } = require('./lib/commands');
const { SelfUpdate } = require('./lib/selfupdate');
const { Notify } = require('./lib/notify');
const prom = require('./lib/prom');
const crypto = require('crypto');
const zlib = require('zlib');
const { Users, Sessions, Throttle, verifyPassword, getDummyHash, verifyTotp, roleAtLeast } = require('./lib/auth');
const { Oidc, roleFor } = require('./lib/oidc');
const { SsoSettings } = require('./lib/sso');
const { SystemSettings, LISTEN: LISTEN_KEYS, fromEnv: systemFromEnv } = require('./lib/system');
const { Listener } = require('./lib/listener');
const { maskIps, maskDeep } = require('./lib/redact');
const properties = require('./lib/properties');

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// A server rconsole installed itself takes the place of MC_DIR/MC_SERVICE
// (lib/active.js). Without one and without RCON_PASSWORD, rconsole starts
// anyway so the first server can be created from the browser.
const legacyServer = fs.existsSync(path.join(config.mcDir, 'server.properties'));
// The attached server's own folder and RCON, before an installed server takes their place.
const legacy = { mcDir: config.mcDir, rconPort: config.rconPort, rconHost: config.rconHost };
const activeInstance = active.pick({ serversDir: config.serversDir, stateDir: config.stateDir, legacy: legacyServer, log });
if (activeInstance) Object.assign(config, active.overrides(config.serversDir, activeInstance));
else config.activeServer = null;
if (!activeInstance && !config.rconPassword && fs.existsSync(path.join(config.mcDir, 'server.properties'))) {
  console.error('Missing required environment variable RCON_PASSWORD (for the server in MC_DIR)');
  process.exit(1);
}
if (!config.rconPassword) log(activeInstance ? `WARNING: ${activeInstance.id} has no RCON password in server.properties` : 'No server yet: create one under Servers (RCON_PASSWORD is only needed for a server rconsole did not install)');

const rcon = new Rcon({ host: config.rconHost, port: config.rconPort, password: config.rconPassword });
const logTail = new LogTail(path.join(config.mcDir, 'logs', 'latest.log'));
const stats = new Stats({ rcon, mcDir: config.mcDir, heapMax: activeInstance ? activeInstance.memoryMb * 1024 * 1024 : null });
const jobs = new Jobs({ backupDir: config.backupDir, runner: config.jobRunner, log, instance: config.activeServer });
const activeWorld = async () => (await readProperties(config.mcDir))['level-name'] || 'world';
const backups = new Backups({ rcon, jobs, backupDir: config.backupDir, keep: config.backupKeep, compression: config.backupCompression, log, activeWorld });
const power = new Power({ unit: config.mcService, log });
const countdown = new Countdown({ rcon, log, power });
const ops = new Ops({ log });
const worlds = new Worlds({ mcDir: config.mcDir, stateDir: config.stateDir, jobs, backups, power, countdown, ops, rcon, log });
const maintenance = new Maintenance({ mcDir: config.mcDir, stateDir: config.stateDir, rcon, log });
const pending = new Pending({ stateDir: config.stateDir, power });
const platform = platformLib.detector(config.mcDir);
const activeInstance$ = () => (config.activeServer ? servers.get(config.activeServer) : null);
// Errors reading the active server's instance.json surface instead of
// falling back to the MC_DIR updates, which would install the wrong jar.
const updates = new Updates({ jobs, backups, countdown, mcDir: config.mcDir, mcJar: config.mcJar, log, platform, power, rcon, instance: activeInstance$ });
const gameVersion = async () => (await updates.installed())?.version || null;
const plugins = new Plugins({ mcDir: config.mcDir, jobs, pending, log, gameVersion, platform, hashesFile: path.join(config.backupDir, '.plugin-hashes', `${config.activeServer || 'attached'}.json`) });
const spark = new Spark({ mcDir: config.mcDir, rcon, plugins, log });
const playerInfo = new PlayerInfo({ mcDir: config.mcDir, rcon, log });
const configs = new Configs({ mcDir: config.mcDir });
const commandCatalog = new CommandCatalog({ rcon, log });
const notify = new Notify({ stateDir: config.stateDir, log, publicUrl: config.publicUrl });
const selfUpdate = new SelfUpdate({ dir: __dirname, stateDir: config.stateDir, runner: config.jobRunner, log });
const audit = new Audit({ stateDir: config.stateDir, log, onRecord: (e) => notify.onAudit(e) });
// Operations run in the background after the request returned 202; record how they ended.
ops.onFinish = (st) => audit.record({ user: st.user, action: 'operation', target: st.label, ok: !st.error, ...(st.error ? { error: st.error } : {}) });
// Servers rconsole installed itself (SERVERS_DIR). Their own operation slot,
// so installing a server doesn't block the current one's restarts.
const serverOps = new Ops({ log });
serverOps.onFinish = ops.onFinish;
// rconsole-limits.service (root, via polkit): MemoryMax and port lock for
// every server, and the RCON firewall. Waits for it; missing on hosts that
// haven't run the 4.3 installer or update yet.
function runLimits() {
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn('systemctl', ['start', 'rconsole-limits.service'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(/not found|could not be found/i.test(err) ? 'rconsole-limits.service is not installed (run install.sh again)' : err.trim() || `systemctl exited with ${code}`))));
  });
}
const servers = new Servers({ serversDir: config.serversDir, jobs, ops: serverOps, log, limits: config.jobRunner === 'systemd' ? runLimits : null });
// rconsole restarts (systemd brings it back) to switch servers, but never
// in the middle of an update, operation or countdown: those would stop
// halfway, with the server down.
function restartWhenIdle() {
  // serverOps is checked once its own operation (the create or delete that
  // asked for the restart) has had time to finish.
  const busy = () => ops.busy() || serverOps.busy() || Boolean(updates.running) || countdown.endsAt != null;
  const tick = () => (busy() ? setTimeout(tick, 2000) : setTimeout(() => {
    sessions.flush(); // everyone stays signed in across the restart
    process.exit(75);
  }, 500));
  setTimeout(tick, 1500);
}

// The first server becomes the active one; rconsole restarts (systemd brings
// it back) to run every view on it.
servers.onCreated = (id, kind) => {
  if (config.activeServer || legacyServer || kind !== 'server') return;
  active.setActive(config.stateDir, id);
  log(`servers: ${id} is now the active server; restarting rconsole`);
  restartWhenIdle();
};
// Deleting the active server moves rconsole to the next one (or to none).
servers.onDeleted = (id) => {
  if (id !== config.activeServer) return;
  log(`servers: the active server ${id} was deleted; restarting rconsole`);
  restartWhenIdle();
};
const metrics = new Metrics({ stats, power, stateDir: config.stateDir, log });
const playerHistory = new PlayerHistory({ mcDir: config.mcDir, stateDir: config.stateDir, log });
const scanners = new Scanners({ onAttempt: (a) => notify.onScanner(a) });
const offsite = new Offsite({
  stateDir: config.stateDir, backupDir: config.backupDir, log,
  onResult: (r) => !r.ok && notify.send('backup', { title: 'Offsite upload failed', message: `${r.file}\n\n${r.error}`, key: `offsite-${r.file}` }),
});
backups.onCreated = (file) => offsite.onBackup(file);
// RCON ports of every server, for the "reachable from other machines" check.
function rconPorts() {
  const out = instances.list(config.serversDir).map((i) => {
    let port = i.rconPort;
    if (!port) {
      try {
        port = Number(properties.toObject(properties.parse(fs.readFileSync(path.join(config.serversDir, i.id, 'server.properties'), 'utf8')))['rcon.port']) || null;
      } catch {}
    }
    return { name: i.name, port };
  });
  if (legacyServer && /^(127\.|::1$|localhost$)/.test(legacy.rconHost)) out.push({ name: path.basename(legacy.mcDir), port: legacy.rconPort });
  return out;
}
function readLimitsStatus() {
  try {
    return JSON.parse(fs.readFileSync('/run/rconsole-limits/status.json', 'utf8'));
  } catch {
    return null;
  }
}
const problems = new Problems({
  mcDir: config.mcDir, stateDir: config.stateDir, log, onProblem: (g) => notify.onProblem(g),
  checks: () => [...hostcheck.check({ rcon: rconPorts(), firewall: readLimitsStatus() }), ...proxyCheck()],
});
// One-tap actions from notifications (opt-in, see lib/notify.js).
notify.handlers = {
  ban: async (ip) => {
    if (!/^[0-9a-fA-F:.]{3,45}$/.test(String(ip))) throw httpError(400, 'Invalid address');
    const out = await rcon.send(`ban-ip ${ip} Connection scanner`);
    audit.record({ user: 'ntfy', action: 'command', target: `/ban-ip ${ip}` });
    return out;
  },
  start: async () => {
    const st = await power.state();
    if (st.active === 'active') return 'Already running';
    await power.run('start');
    audit.record({ user: 'ntfy', action: 'server start' });
    return 'Starting';
  },
};
const scheduler = new Scheduler({ rcon, backups, countdown, stateDir: config.stateDir, log, audit: (e) => audit.record(e) });
const users = new Users(config.stateDir);
const sessions = new Sessions(path.join(config.stateDir, 'sessions.json'));
const throttle = new Throttle();
const lastTotpStep = new Map(); // user -> last accepted TOTP step, blocks code replay

const COOKIE = 'rconsole_session';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
const OIDC_COOKIE = 'rconsole_oidc';

// Single sign-on: set in Settings → Account (STATE_DIR/sso.json) or with
// OIDC_* in /etc/rconsole.env. Rebuilt whenever the settings or the
// rconsole URL change, without a restart.
const ssoSettings = new SsoSettings({ stateDir: config.stateDir, envConfig: config });
let sso = ssoSettings.get();
let oidc = null;
let ssoError = null;

function buildOidc(s) {
  if (!s.enabled) return { client: null, error: null };
  const missing = [['issuer', s.issuer], ['client ID', s.clientId], ['client secret', s.clientSecret], ['rconsole URL', notify.publicUrl]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { client: null, error: `missing ${missing.join(', ')}` };
  try {
    return { client: new Oidc({ ...s, redirectUri: `${notify.publicUrl}/auth/oidc/callback`, postLogoutUri: `${notify.publicUrl}/login` }), error: null };
  } catch (err) {
    return { client: null, error: err.message };
  }
}

function applySso() {
  sso = ssoSettings.get();
  ({ client: oidc, error: ssoError } = buildOidc(sso));
  if (oidc) log(`sso: ${sso.name} via ${sso.issuer}${sso.localLogin ? '' : ' (local accounts off)'}`);
  else if (ssoError) log(`sso: off, ${ssoError}`);
}
applySso();

// ---------------------------------------------------------------------------
// Static files (loaded once, served from memory)
// ---------------------------------------------------------------------------

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
const IMMUTABLE = { 'Cache-Control': 'public, max-age=604800' };
// Text files are compressed once at start and revalidated by ETag: the
// browser keeps them between visits and asks only "still the same?".
const load = (file, headers) => {
  const body = fs.readFileSync(path.join(__dirname, 'public', file));
  const type = types[path.extname(file)];
  if (headers || !/^text\/|svg/.test(type)) return { body, type, headers };
  return {
    body,
    type,
    headers: { 'Cache-Control': 'no-cache', ETag: `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 16)}"` },
    br: zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } }),
    gzip: zlib.gzipSync(body, { level: 9 }),
  };
};

function serveStatic(req, res, f) {
  if (f.headers?.ETag && req.headers['if-none-match'] === f.headers.ETag) {
    res.writeHead(304, { ...SECURITY_HEADERS, ...f.headers });
    return res.end();
  }
  const enc = pickEncoding(req);
  if (enc && f[enc]) return send(res, 200, f[enc], f.type, { ...f.headers, 'Content-Encoding': enc, Vary: 'Accept-Encoding' });
  return send(res, 200, f.body, f.type, { ...f.headers, ...(f.br ? { Vary: 'Accept-Encoding' } : {}) });
}

const PUBLIC_FILES = {
  '/login': load('login.html'),
  '/login.js': load('login.js'),
  '/confirm-address': load('confirm.html'),
  '/confirm.js': load('confirm.js'),
  '/style.css': load('style.css'),
  '/favicon.svg': load('favicon.svg', IMMUTABLE),
  '/notify-icon.png': load('notify-icon.png', IMMUTABLE), // ntfy shows it next to notifications
  '/fonts/inter.woff2': load('fonts/inter.woff2', IMMUTABLE),
  '/fonts/jetbrains-mono.woff2': load('fonts/jetbrains-mono.woff2', IMMUTABLE),
};
const APP_FILES = { '/': load('index.html'), '/app.js': load('app.js'), '/commands.js': load('commands.js') };

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' https://mc-heads.net https://cdn.modrinth.com; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const httpError = (status, message, extra) => Object.assign(new Error(message), { status, extra });

const pickEncoding = (req) => {
  const accept = String(req?.headers['accept-encoding'] || '');
  return /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
};

// API answers over 1 KB are compressed (metrics, plugin lists, logs); fast
// settings, as they are made per request.
function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  let payload = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
  const enc = !headers['Content-Encoding'] && /json|text\/plain/.test(type) && Buffer.byteLength(payload) > 1024 ? pickEncoding(res.req) : null;
  if (enc) {
    payload = enc === 'br' ? zlib.brotliCompressSync(payload, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }) : zlib.gzipSync(payload, { level: 5 });
    headers = { ...headers, 'Content-Encoding': enc, Vary: 'Accept-Encoding' };
  }
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...headers });
  res.end(payload);
}

const fromTrustedProxy = (req) => config.trustProxy.includes(String(req.socket.remoteAddress).replace(/^::ffff:/, ''));

function clientIp(req) {
  const direct = String(req.socket.remoteAddress).replace(/^::ffff:/, '');
  const xff = req.headers['x-forwarded-for'];
  // The proxy appends the address it saw, so the last entry is the one it vouches for.
  if (xff && fromTrustedProxy(req)) return xff.split(',').pop().trim();
  return direct;
}

// A reverse proxy that isn't in TRUST_PROXY makes every visitor look like
// the proxy: one lockout for everyone, no HSTS, no Secure cookie. Noticed
// from its X-Forwarded-For header and shown under Problems and About.
let untrustedProxy = null; // { address, at }
function noteProxy(req) {
  if (!req.headers['x-forwarded-for'] || fromTrustedProxy(req)) return;
  untrustedProxy = { address: String(req.socket.remoteAddress).replace(/^::ffff:/, ''), at: Date.now() };
}
function proxyCheck() {
  if (!untrustedProxy || Date.now() - untrustedProxy.at > 24 * 3600 * 1000) return [];
  const a = untrustedProxy.address;
  return [{ kind: 'host', severity: 'warning', title: 'Reverse proxy not trusted', message: `Requests come through ${a}, which sends X-Forwarded-For, but TRUST_PROXY doesn't list it. rconsole sees every visitor as ${a}: five wrong passwords from anyone lock out all password sign-ins, and HSTS and secure cookies stay off.`, hint: `Add ${a} under Settings → System → Web access → Trusted proxies.` }];
}

const isHttps = (req) => fromTrustedProxy(req) && req.headers['x-forwarded-proto'] === 'https';

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    // Malformed percent-encoding (anyone can send it) must not throw.
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(raw);
    } catch {
      out[part.slice(0, i).trim()] = raw;
    }
  }
  return out;
}

function sessionCookie(req, value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

// Returns the signed-in user name, or null. Sessions die when the user is
// removed or their password changes (the CLI edits users.json directly).
function sessionUser(token) {
  const s = sessions.get(token);
  if (!s) return null;
  const user = users.get(s.user);
  if (!user || Date.parse(user.changed || 0) > s.created) {
    sessions.destroy(token);
    return null;
  }
  return s.user;
}

const currentUser = (req) => sessionUser(cookies(req)[COOKIE]);

// Same-origin check for state-changing requests, on top of SameSite=Strict cookies.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return !req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin';
  try {
    const host = new URL(origin).host;
    return host === req.headers.host || (fromTrustedProxy(req) && host === req.headers['x-forwarded-host']);
  } catch {
    return false;
  }
}

function readJson(req, limit = 16 * 1024) {
  // Requiring JSON means a cross-site form post can't reach the API.
  if (!String(req.headers['content-type']).startsWith('application/json')) {
    return Promise.reject(httpError(415, 'Content-Type must be application/json'));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        req.body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(req.body);
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Open log streams per session: a few tabs are normal, hundreds are not.
const STREAMS_PER_SESSION = 8;
const streams = new Map(); // session cookie -> open streams

function streamLogs(req, res) {
  const session = cookies(req)[COOKIE];
  if ((streams.get(session) || 0) >= STREAMS_PER_SESSION) return send(res, 429, { error: 'Too many open log views; close some tabs' });
  streams.set(session, (streams.get(session) || 0) + 1);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  // Player addresses are for moderators and admins.
  const mask = roleAtLeast(req.role, 'moderator') ? (l) => l : maskIps;
  event('backlog', { lines: logTail.backlog.map(mask), error: logTail.error });
  const onLine = (line) => event('line', mask(line));
  const onStatus = (error) => event('status', { error });
  logTail.on('line', onLine);
  logTail.on('status', onStatus);
  const ping = setInterval(() => {
    // Also ends the stream once the session is gone (logout, password change).
    if (!currentUser(req)) return res.end();
    res.write(': ping\n\n');
  }, 15000);
  req.on('close', () => {
    if (streams.get(session) > 1) streams.set(session, streams.get(session) - 1);
    else streams.delete(session);
    clearInterval(ping);
    logTail.off('line', onLine);
    logTail.off('status', onStatus);
  });
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

const loginsInFlight = new Map(); // ip -> password checks running
let loginsTotal = 0;

async function login(req, res) {
  const { username, password, code } = await readJson(req);
  const name = String(username || '').trim().toLowerCase().slice(0, 64);
  const ip = clientIp(req);
  // Per address, and per address and name. Not per name alone: then anyone
  // could lock the real user out with five wrong passwords.
  const keys = [`ip:${ip}`, `user:${ip}|${name}`];

  if (!sso.localLogin) throw httpError(403, `Sign in with ${sso.name}`);
  if (!Object.values(users.load()).some((u) => u.hash)) throw httpError(503, 'No users configured yet. On the server run: node cli.js user add <name>');

  const wait = throttle.blocked(...keys);
  if (wait) {
    log(`auth: blocked login for "${name}" from ${ip} (${wait}s left)`);
    audit.record({ user: name, ip, action: 'login', ok: false, error: 'locked out' });
    throw httpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} min.`, { 'Retry-After': wait });
  }

  // The throttle counts failures only after scrypt has run, so cap how many
  // run at once: a burst from one address can't queue up hashing work (and
  // starve the libuv pool that file I/O shares) before the lockout applies.
  if ((loginsInFlight.get(ip) || 0) >= 2 || loginsTotal >= 8) throw httpError(429, 'Too many sign-in attempts at once. Try again in a moment.', { 'Retry-After': 2 });
  loginsInFlight.set(ip, (loginsInFlight.get(ip) || 0) + 1);
  loginsTotal++;
  let ok;
  let user;
  try {
    user = users.get(name);
    ok = (await verifyPassword(String(password || '').slice(0, 1024), user?.hash ?? (await getDummyHash()))) && user;
  } finally {
    loginsTotal--;
    if (loginsInFlight.get(ip) > 1) loginsInFlight.set(ip, loginsInFlight.get(ip) - 1);
    else loginsInFlight.delete(ip);
  }
  if (!ok) {
    throttle.fail(...keys);
    log(`auth: failed login for "${name}" from ${ip}`);
    audit.record({ user: name, ip, action: 'login', ok: false, error: 'wrong password' });
    throw httpError(401, 'Invalid username or password');
  }

  if (!user.totp && config.require2fa.includes(users.roleOf(name))) {
    log(`auth: ${name} has no 2FA, which is required for ${users.roleOf(name)}s`);
    audit.record({ user: name, ip, action: 'login', ok: false, error: '2FA required, not set up' });
    throw httpError(403, `Your role needs two-factor sign-in. On the server, run: node cli.js user totp ${name}`);
  }

  if (user.totp) {
    if (!code) return [401, { needCode: true }];
    const given = String(code).replace(/\s/g, '');
    const step = /^\d{6}$/.test(given) ? verifyTotp(user.totp, given) : null;
    if (step === null && users.useRecovery(name, given)) {
      const left = (users.get(name).recovery || []).length;
      log(`auth: ${name} used a recovery code (${left} left)`);
      audit.record({ user: name, ip, action: 'recovery code used', target: `${left} left` });
    } else if (step === null || step <= (lastTotpStep.get(name) ?? -1)) {
      throttle.fail(...keys);
      log(`auth: wrong 2FA code for "${name}" from ${ip}`);
      audit.record({ user: name, ip, action: 'login', ok: false, error: 'wrong 2FA code' });
      throw httpError(401, 'Invalid code', { needCode: true });
    } else lastTotpStep.set(name, step);
  }

  throttle.reset(...keys);
  const token = sessions.create(name);
  log(`auth: ${name} signed in from ${ip}`);
  audit.record({ user: name, ip, action: 'login' });
  res.setHeader('Set-Cookie', sessionCookie(req, token, COOKIE_MAX_AGE));
  return { user: name };
}

async function logout(req, res) {
  const user = currentUser(req);
  const s = sessions.get(cookies(req)[COOKIE]);
  sessions.destroy(cookies(req)[COOKIE]);
  if (user) {
    log(`auth: ${user} signed out`);
    audit.record({ user, ip: clientIp(req), action: 'logout' });
  }
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  // Ends the provider session too, so "sign out" doesn't sign straight back in.
  const redirect = s?.via === 'sso' && oidc ? await oidc.logoutUrl(s.idToken).catch(() => null) : null;
  return { ok: true, redirect };
}

// ---------------------------------------------------------------------------
// Single sign-on (OpenID Connect)
// ---------------------------------------------------------------------------

function oidcCookie(req, value, maxAge) {
  // Lax: it must come back on the provider's cross-site redirect to the callback.
  return `${OIDC_COOKIE}=${value}; Path=/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

const toLogin = (res, error, extra = {}) => send(res, 302, '', 'text/plain', { Location: `/login?error=${error}`, ...extra });

async function ssoStart(req, res) {
  if (!oidc) return toLogin(res, 'sso_off');
  const ip = clientIp(req);
  if (throttle.blocked(`ip:${ip}`)) return toLogin(res, 'sso_locked');
  // ?link=1 from Settings → Account: tie the provider user to the local
  // account signed in here with its password. The session cookie is
  // SameSite=Strict, so a link from another site can't start this.
  let link = null;
  if (new URL(req.url, 'http://x').searchParams.get('link') === '1') {
    const s = sessions.get(cookies(req)[COOKIE]);
    const u = s && users.get(s.user);
    if (!u || s.via !== 'password' || u.sso) return toLogin(res, 'sso_link');
    link = { user: s.user, changed: u.changed };
  }
  try {
    const { url, cookie } = await oidc.begin({ link });
    send(res, 302, '', 'text/plain', { Location: url, 'Set-Cookie': oidcCookie(req, cookie, 600) });
  } catch (err) {
    log(`sso: can't start sign-in: ${err.message}`);
    toLogin(res, 'sso_unavailable');
  }
}

async function ssoCallback(req, res) {
  const ip = clientIp(req);
  const clear = { 'Set-Cookie': oidcCookie(req, '', 0) };
  if (!oidc) return toLogin(res, 'sso_off', clear);
  if (throttle.blocked(`ip:${ip}`)) return toLogin(res, 'sso_locked', clear);
  const q = new URL(req.url, 'http://x').searchParams;
  let result;
  try {
    result = await oidc.finish({ code: q.get('code'), state: q.get('state'), error: q.get('error'), cookie: cookies(req)[OIDC_COOKIE] });
  } catch (err) {
    // A stale or foreign attempt (back button, two tabs) isn't guessing anything: no lockout for it.
    if (err.code !== 'state') throttle.fail(`ip:${ip}`);
    log(`sso: sign-in failed from ${ip}: ${JSON.stringify(err.message)}`);
    audit.record({ user: '?', ip, action: 'login', ok: false, target: sso.name, error: err.message.slice(0, 200) });
    return toLogin(res, err.code === 'state' ? 'sso_state' : 'sso_failed', clear);
  }
  const { claims, idToken, groups } = result;
  const label = claims.preferred_username || claims.email || claims.sub;
  const role = roleFor(groups, sso.groups);
  if (!role) {
    log(`sso: ${JSON.stringify(String(label))} has none of the rconsole groups (has: ${JSON.stringify(groups)})`); // provider values, quoted: no forged log lines
    audit.record({ user: String(label), ip, action: 'login', ok: false, target: sso.name, error: 'not in an rconsole group' });
    return toLogin(res, 'sso_denied', clear);
  }
  const ident = { iss: claims.iss, sub: claims.sub, username: claims.preferred_username, name: claims.name, email: claims.email, role };
  let name;
  if (result.link) {
    // The account must be the one that started the link, unchanged since
    // (no password change, no sign-out of all sessions in between).
    const u = users.get(result.link.user);
    if (!u || u.sso || u.changed !== result.link.changed) {
      audit.record({ user: result.link.user, ip, action: 'sso link', ok: false, target: sso.name, error: 'account changed while linking' });
      return toLogin(res, 'sso_link', clear);
    }
    let merged;
    ({ name, merged } = users.linkSso(result.link.user, ident));
    log(`auth: ${name} linked to ${sso.name} user ${JSON.stringify(String(label))}${merged ? `, merged ${merged} into it` : ''}`);
    audit.record({ user: name, ip, action: 'sso link', target: `${sso.name} · ${String(label).slice(0, 100)}${merged ? ` · merged ${merged}` : ''}` });
  } else {
    const namesake = users.localNamesake(ident);
    name = users.upsertSso(ident);
    if (namesake) log(`sso: ${JSON.stringify(String(label))} got the new account ${name}, not the local ${namesake}. To use ${namesake}, sign in with its password and link it in Settings → Account, or run: node cli.js user link ${namesake} ${name}`);
  }
  throttle.reset(`ip:${ip}`);
  sessions.destroy(cookies(req)[COOKIE]); // whoever was signed in on this browser before is signed out
  const token = sessions.create(name, { via: 'sso', idToken, maxAge: sso.sessionHours * 3600 * 1000 });
  log(`auth: ${name} signed in with ${sso.name} from ${ip} as ${role}`);
  audit.record({ user: name, ip, action: 'login', target: `${sso.name} · ${role}` });
  // A page, not a redirect: the browser treats a redirect chain that began
  // at the provider as cross-site and would hold back the SameSite=Strict
  // session cookie on the way to /.
  const dest = result.link ? '/?linked#settings/account' : '/';
  const page = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${dest}"><title>Signing in…</title><p><a href="${dest}">Continue to rconsole</a></p>`;
  send(res, 200, page, 'text/html; charset=utf-8', { 'Set-Cookie': [sessionCookie(req, token, Math.round(sso.sessionHours * 3600)), oidcCookie(req, '', 0)] });
}

// ---------------------------------------------------------------------------
// API routes (all require a session)
// ---------------------------------------------------------------------------

const routes = [];
const route = (method, pattern, handler, audited = true) => routes.push({ method, pattern, handler, audited });

// Audit names for state-changing requests: [method, path, (params, body, query) => [action, target]].
const dec = decodeURIComponent;
const AUDIT_NAMES = [
  ['POST', /^\/api\/command$/, (p, b) => ['command', `/${String(b.command || '').replace(/^\//, '')}`]],
  ['POST', /^\/api\/server\/power$/, (p, b) => [`server ${b.action}`, b.seconds ? `in ${b.seconds}s` : '']],
  ['POST', /^\/api\/maintenance$/, (p, b) => [`maintenance ${b.enabled ? 'on' : 'off'}`, '']],
  ['POST', /^\/api\/settings$/, (p, b) => ['settings', Object.entries(b.set || {}).map(([k, v]) => `${k}=${v}`).join(', ')]],
  ['POST', /^\/api\/plugins$/, (p, b) => ['plugin install', b.title ? `${String(b.title).slice(0, 80)} (${b.projectId})` : b.projectId]],
  ['POST', /^\/api\/plugins\/([^/]+)\/update$/, ([f]) => ['plugin update', dec(f)]],
  ['POST', /^\/api\/plugins\/([^/]+)\/toggle$/, ([f], b) => [`plugin ${b.enabled ? 'enable' : 'disable'}`, dec(f)]],
  ['POST', /^\/api\/plugins\/([^/]+)\/rollback$/, ([f]) => ['plugin rollback', dec(f)]],
  ['DELETE', /^\/api\/plugins\/([^/]+)$/, ([f]) => ['plugin remove', dec(f)]],
  ['POST', /^\/api\/worlds$/, (p, b) => ['world create', b.name]],
  ['POST', /^\/api\/worlds\/([\w-]+)\/activate$/, ([n]) => ['world switch', n]],
  ['DELETE', /^\/api\/worlds\/([\w-]+)$/, ([n], b, q) => ['world delete', `${n}${q.get('archive') === '0' ? '' : ' (archived)'}`]],
  ['POST', /^\/api\/backups$/, (p, b) => ['backup create', b.world || 'active world']],
  ['POST', /^\/api\/backups\/([^/]+)\/restore$/, ([n], b) => [`backup restore`, `${dec(n)} → ${b.mode === 'new' ? b.target : 'replace'}`]],
  ['DELETE', /^\/api\/backups\/([^/]+)$/, ([n]) => ['backup delete', dec(n)]],
  ['POST', /^\/api\/restart$/, (p, b) => ['server restart', `in ${b.seconds}s`]],
  ['DELETE', /^\/api\/restart$/, () => ['countdown cancel', '']],
  ['POST', /^\/api\/notify$/, (p, b) => ['notifications', Object.entries(b.events || {}).map(([k, v]) => `${k}=${v ? 'on' : 'off'}`).join(', ') || (b.url !== undefined ? 'topic' : '')]],
  ['POST', /^\/api\/notify\/test$/, () => ['notifications test', '']],
  ['PUT', /^\/api\/sso$/, (p, b) => ['sso settings', b.enabled === false ? 'off' : `${b.name || 'on'}${b.localLogin === false ? ', local accounts off' : ''}`]],
  ['POST', /^\/api\/self-update$/, () => ['rconsole update', (({ current }, latest) => (latest && latest !== current ? `${current} → ${latest}` : current))(selfUpdate.summary(), selfUpdate.check?.latest?.sha?.slice(0, 7))]],
  ['POST', /^\/api\/problems\/seen$/, () => ['problems marked as seen', '']],
  ['POST', /^\/api\/me\/password$/, () => ['password change', '']],
  ['POST', /^\/api\/problems\/mute$/, (p, b) => [b.all ? 'problems unmuted' : b.muted === false ? 'problem unmuted' : 'problem muted', String(b.key || '').slice(0, 120)]],
  ['PUT', /^\/api\/offsite$/, () => ['offsite settings', '']],
  ['PUT', /^\/api\/system$/, (p, b) => ['system settings', [...Object.keys(b.set || {}).map((k) => (k === 'metricsToken' ? (b.set[k] ? 'metrics on' : 'metrics off') : `${k}=${JSON.stringify(b.set[k])}`)), ...(b.reset || []).map((k) => `${k} reset`)].join(', ').slice(0, 300)]],
  ['DELETE', /^\/api\/system\/trial$/, () => ['web address change cancelled', '']],
  ['PUT', /^\/api\/map$/, (p, b) => ['map', String(b.url || 'off').slice(0, 100)]],
  ['PUT', /^\/api\/configs\/file$/, (p, b) => ['config edit', b.path]],
  ['POST', /^\/api\/configs\/revert$/, (p, b) => ['config revert', b.path]],
  ['POST', /^\/api\/chat$/, (p, b) => [b.to ? `whisper to ${b.to}` : 'chat', String(b.message || '').slice(0, 120)]],
  ['POST', /^\/api\/spark$/, (p, b) => [`spark ${b.kind === 'health' ? 'health report' : 'profile'}`, '']],
  ['POST', /^\/api\/offsite\/upload$/, (p, b) => ['offsite upload', b.file]],
  ['POST', /^\/api\/offsite\/download$/, (p, b) => ['offsite download', b.name]],
  ['POST', /^\/api\/servers$/, (p, b) => ['server create', `${b.id} (${b.distribution} ${b.version}${b.build ? ` #${b.build}` : ''}), EULA accepted`]],
  ['PATCH', /^\/api\/servers\/([a-z0-9-]+)$/, ([id], b) => ['server settings', `${id}: ${['memoryMb', 'flags', 'autostart', 'portLock', 'extraPorts'].filter((k) => b[k] !== undefined).map((k) => `${k}=${JSON.stringify(b[k])}`).join(', ')}`]],
  ['POST', /^\/api\/servers\/([a-z0-9-]+)\/power$/, ([id], b) => [`server ${b.action}`, id]],
  ['POST', /^\/api\/worlds\/([\w-]+)\/pregenerate$/, ([name], b) => ['world pre-generate', `${name}, radius ${b.radius}`]],
  ['POST', /^\/api\/servers\/([a-z0-9-]+)\/console$/, ([id], b) => ['command', `${id}: /${String(b.command || '').replace(/^\//, '')}`]],
  ['POST', /^\/api\/servers\/([a-z0-9-]+)\/show$/, ([id]) => ['server show', id]],
  ['DELETE', /^\/api\/servers\/([a-z0-9-]+)$/, ([id], b, q) => ['server delete', `${id}${q.get('archive') === '0' ? '' : ' (archived)'}`]],
  ['DELETE', /^\/api\/offsite\/([^/]+)$/, ([n]) => ['offsite delete', dec(n)]],
  ['POST', /^\/api\/updates$/, (p, b) => ['update', b.rollback ? 'rollback' : `${b.version} #${b.build}`]],
  ['POST', /^\/api\/tasks$/, (p, b) => ['task create', `${b.type} ${b.time || ''}`.trim()]],
  ['PATCH', /^\/api\/tasks\/([\w-]+)$/, ([id]) => ['task edit', id]],
  ['DELETE', /^\/api\/tasks\/([\w-]+)$/, ([id]) => ['task delete', id]],
  ['POST', /^\/api\/tasks\/([\w-]+)\/run$/, ([id]) => ['task run', id]],
];

// Who may call what. Reading needs a viewer, changing anything an admin,
// except for the entries here.
const ROLE_RULES = [
  ['POST', /^\/api\/logout$/, 'viewer'],
  ['POST', /^\/api\/command$/, 'moderator'], // moderators: MODERATOR_COMMANDS only
  ['POST', /^\/api\/problems\/seen$/, 'moderator'],
  ['POST', /^\/api\/me\/password$/, 'viewer'], // their own
  ['POST', /^\/api\/chat$/, 'moderator'],
  ['GET', /^\/api\/players\/history$/, 'moderator'], // addresses of players
  ['GET', /^\/api\/audit$/, 'admin'],
  ['GET', /^\/api\/notify$/, 'admin'],
  ['GET', /^\/api\/configs/, 'admin'], // configs often hold passwords
  ['GET', /^\/api\/offsite/, 'admin'],
  ['GET', /^\/api\/users$/, 'admin'], // who has access, and how
  ['GET', /^\/api\/system$/, 'admin'], // addresses, proxies, paths
  ['GET', /^\/api\/about$/, 'admin'], // paths and settings of this install
  ['GET', /^\/api\/sso$/, 'admin'],
  ['GET', /^\/api\/backups\/[^/]+$/, 'admin'], // downloads whole worlds
];
const requiredRole = (method, pathname) => ROLE_RULES.find(([m, re]) => m === method && re.test(pathname))?.[2] || (method === 'GET' || method === 'HEAD' ? 'viewer' : 'admin');

// Console commands a moderator may run: talking to players and moderation.
const MODERATOR_COMMANDS = new Set([
  'say', 'me', 'tell', 'msg', 'w', 'tellraw', 'list', 'tps', 'mspt', 'help',
  'kick', 'ban', 'ban-ip', 'pardon', 'pardon-ip', 'banlist', 'whitelist',
  'tp', 'teleport', 'gamemode', 'spectate', 'mute', 'unmute', 'tempban', 'tempmute', 'warn', 'unban',
]);
const commandName = (cmd) => String(cmd).trim().replace(/^\//, '').split(/\s+/)[0].toLowerCase().replace(/^[a-z0-9_.-]+:/, '');

function auditRequest(req, pathname, status, error) {
  const url = new URL(req.url, 'http://x');
  let action = `${req.method} ${pathname}`;
  let target = '';
  for (const [method, re, name] of AUDIT_NAMES) {
    const m = method === req.method && pathname.match(re);
    if (!m) continue;
    try {
      [action, target] = name(m.slice(1), req.body || {}, url.searchParams);
    } catch {}
    break;
  }
  audit.record({ user: req.user, role: req.role === 'admin' ? undefined : req.role, ip: clientIp(req), action, target: String(target || '').slice(0, 300) || undefined, detail: action === 'command' ? undefined : summarize(req.body), ok: !error, status, error });
}

route('GET', /^\/api\/notify$/, () => notify.view());
route('POST', /^\/api\/notify$/, async (req) => {
  const r = notify.update(await readJson(req));
  applySso(); // the rconsole URL is also the sign-in redirect
  return r;
});

// Settings → Account → Single sign-on.
function ssoView(req) {
  return {
    ...ssoSettings.view(),
    active: Boolean(oidc),
    error: ssoError,
    publicUrl: notify.publicUrl || null,
    publicUrlFromEnv: Boolean(config.publicUrl),
    redirectUri: notify.publicUrl ? `${notify.publicUrl}/auth/oidc/callback` : null,
    youUseSso: sessions.get(cookies(req)[COOKIE])?.via === 'sso',
  };
}
route('GET', /^\/api\/sso$/, (req) => ssoView(req));
route('PUT', /^\/api\/sso$/, async (req) => {
  const body = await readJson(req);
  if (body.publicUrl !== undefined && !config.publicUrl) notify.update({ publicUrl: body.publicUrl });
  const next = ssoSettings.next(body);
  const eff = ssoSettings.get(next);
  if (eff.enabled) {
    const { client, error } = buildOidc(eff);
    if (error) throw httpError(400, `Can't turn on single sign-on: ${error}`);
    try {
      await client.discover(); // reachable, and it is who it says it is
    } catch (err) {
      throw httpError(400, `Can't reach the provider: ${err.message}`);
    }
  }
  // Turning local accounts off is only safe once SSO has worked for you.
  if (!eff.localLogin && !(oidc && sessions.get(cookies(req)[COOKIE])?.via === 'sso')) {
    throw httpError(400, `Sign in with ${eff.name} once before turning off local accounts, so you know it works.`);
  }
  ssoSettings.save(next);
  applySso();
  return ssoView(req);
});
route('POST', /^\/api\/notify\/test$/, async (req) => {
  if (!notify.config.url && !notify.config.discord.url) throw httpError(409, 'Set an ntfy topic URL or a Discord webhook first');
  try {
    await notify.test(req.user);
  } catch (err) {
    throw httpError(502, `ntfy: ${err.message}`);
  }
  return { ok: true };
});
route('GET', /^\/api\/map$/, (req) => ({
  configured: Boolean(mapUrl()),
  src: mapUrl() ? `/map/${mapToken(req)}/` : null,
  fromEnv: Boolean(config.mapUrl),
  ...(roleAtLeast(req.role, 'admin') ? { url: mapUrl() || null, detected: mapDetect.detect(config.mcDir) } : {}),
}));
// The map rconsole shows, when MAP_URL doesn't set it: a web map plugin on
// this machine (Map tab → "Use BlueMap").
route('PUT', /^\/api\/map$/, async (req) => {
  if (config.mapUrl) throw httpError(409, 'MAP_URL in /etc/rconsole.env sets the map; change it there.');
  const url = String((await readJson(req)).url || '').trim().replace(/\/+$/, '');
  if (url && !mapDetect.validMapUrl(url)) throw httpError(400, 'The map must run on this machine: http://127.0.0.1:<port>');
  saveMapUrl(url);
  return { url: url || null };
});
route('GET', /^\/api\/self-update$/, (req) => selfUpdate.overview({ refresh: new URL(req.url, 'http://x').searchParams.has('refresh') }));
route('POST', /^\/api\/self-update$/, async (req) => [202, await selfUpdate.start()]);
route('GET', /^\/api\/commands$/, (req) => commandCatalog.list({ refresh: new URL(req.url, 'http://x').searchParams.has('refresh') }));
route('GET', /^\/api\/metrics$/, (req) => metrics.series(new URL(req.url, 'http://x').searchParams.get('range') || '24h'));
route('GET', /^\/api\/players\/([A-Za-z0-9_]{1,16})\/profile$/, (req, res, [name]) => {
  const q = new URL(req.url, 'http://x').searchParams;
  return q.get('part') === 'vitals' ? playerInfo.vitals(name) : playerInfo.profile(name, { uuid: q.get('uuid') });
});
route('GET', /^\/api\/players\/history$/, () => playerHistory.history());
route('GET', /^\/api\/configs$/, () => configs.list());
route('GET', /^\/api\/configs\/file$/, (req) => configs.read(new URL(req.url, 'http://x').searchParams.get('path')));
route('PUT', /^\/api\/configs\/file$/, async (req) => {
  const { path: file, content } = await readJson(req, CONFIG_MAX * 2 + 4096);
  configs.read(file); // same checks as the helper's, with clear errors
  const r = await jobs.run('config-write', { file, content: String(content ?? '') });
  pending.add(`config ${file}`);
  return { ...r, ...configs.read(file) };
});
route('POST', /^\/api\/configs\/revert$/, async (req) => {
  const { path: file } = await readJson(req);
  configs.read(file);
  const r = await jobs.run('config-write', { file, revert: true });
  pending.add(`config ${file}`);
  return { ...r, ...configs.read(file) };
});
route('GET', /^\/api\/spark$/, () => spark.status());
route('POST', /^\/api\/spark$/, async (req) => {
  const { kind, seconds } = await readJson(req);
  return [202, await spark.start(kind === 'health' ? 'health' : 'profile', seconds)];
});
route('GET', /^\/api\/offsite$/, () => offsite.view());
route('PUT', /^\/api\/offsite$/, async (req) => offsite.update(await readJson(req)));
route('POST', /^\/api\/offsite\/test$/, () => offsite.test());
route('GET', /^\/api\/offsite\/list$/, () => offsite.list().then((items) => ({ items })));
route('POST', /^\/api\/offsite\/upload$/, async (req) => [202, offsite.enqueue(String((await readJson(req)).file || ''))]);
route('POST', /^\/api\/offsite\/download$/, async (req) => offsite.download(String((await readJson(req)).name || '')));
route('DELETE', /^\/api\/offsite\/([^/]+)$/, (req, res, [name]) => offsite.remove(decodeURIComponent(name)));
const forRole = (req, data) => (roleAtLeast(req.role, 'moderator') ? data : maskDeep(data)); // player addresses
route('GET', /^\/api\/problems$/, async (req) => forRole(req, await problems.scan({ days: new URL(req.url, 'http://x').searchParams.get('days') })));
route('POST', /^\/api\/problems\/seen$/, async () => problems.markSeen());
route('POST', /^\/api\/problems\/mute$/, async (req) => {
  const { key, muted = true, all } = await readJson(req);
  return all ? problems.unmuteAll() : problems.mute(key, Boolean(muted));
});
route('GET', /^\/api\/logs\/search$/, async (req) => forRole(req, await searchLogs(config.mcDir, Object.fromEntries(new URL(req.url, 'http://x').searchParams))));
route('GET', /^\/api\/audit$/, async (req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  return audit.query({ user: q.get('user') || '', action: q.get('action') || '', q: q.get('q') || '', failed: q.has('failed'), limit: Math.min(Number(q.get('limit')) || 200, 1000) });
});

// Server → Overview: the facts about this server in one place.
route('GET', /^\/api\/server\/summary$/, async () => {
  let p = {};
  try {
    p = properties.toObject(properties.parse(fs.readFileSync(path.join(config.mcDir, 'server.properties'), 'utf8')));
  } catch {}
  const st = await power.state().catch(() => ({}));
  const game = (await stats.get().catch(() => null))?.game; // cached: no extra RCON
  return {
    players: game?.players ? { online: game.players.online, max: game.players.max } : null,
    platform: (({ name, mcVersion, build, loaderVersion, addons }) => ({ name, mcVersion, build, loaderVersion, addons: addons?.kind || null }))(platform()),
    state: { active: st.active || null, since: st.since || null, available: Boolean(st.available) },
    process: await power.processStats().catch(() => null),
    world: p['level-name'] || 'world',
    port: Number(p['server-port']) || 25565,
    motd: p.motd || '',
    maxPlayers: Number(p['max-players']) || null,
    whitelist: p['white-list'] === 'true',
    onlineMode: p['online-mode'] !== 'false',
    difficulty: p.difficulty || null,
    gamemode: p.gamemode || null,
  };
});

// Settings → Sign-in: the accounts (read-only; managed with cli.js or the provider).
route('GET', /^\/api\/users$/, () => ({
  users: Object.entries(users.load()).map(([name, u]) => ({
    name,
    role: users.roleOf(name),
    source: u.sso ? 'sso' : 'local',
    totp: Boolean(u.totp),
    email: u.sso?.email || null,
    displayName: u.sso?.name || null,
    created: u.created || null,
    lastLogin: u.lastLogin || null,
  })).sort((a, b) => a.name.localeCompare(b.name)),
}));

// Settings → About: version and the settings that live in /etc/rconsole.env.
route('GET', /^\/api\/about$/, () => ({
  version: require('./package.json').version,
  commit: selfUpdate.summary().current,
  node: process.version,
  mcDir: config.mcDir,
  mcService: config.mcService,
  backupDir: config.backupDir,
  backupKeep: config.backupKeep,
  stateDir: config.stateDir,
  publicUrl: notify.publicUrl || null, // from PUBLIC_URL or saved under Settings
  publicUrlFromEnv: Boolean(config.publicUrl),
  untrustedProxy: proxyCheck().length ? untrustedProxy.address : null,
  mapUrl: mapUrl() || null,
  metrics: Boolean(config.metricsToken),
  trustProxy: config.trustProxy,
  jobRunner: config.jobRunner,
}));

// Settings → System: the settings that used to live only in
// /etc/rconsole.env (lib/system.js). Everything applies without a restart;
// a new web address runs as a trial (lib/listener.js) and is saved only
// once a request reaches rconsole through it.
const systemSettings = new SystemSettings({ stateDir: config.stateDir });
let pendingListen = null; // { set, reset } for webHost/webPort, saved on confirm

function applySystem(v) {
  config.trustProxy = v.trustProxy;
  config.require2faMode = v.require2fa;
  config.require2fa = config.require2faRoles(v.require2fa);
  config.metricsToken = v.metricsToken;
  config.backupKeep = backups.keep = v.backupKeep;
  config.backupCompression = backups.compression = v.backupCompression;
  config.updateCheck = v.updateCheck;
}

function systemView(req) {
  const direct = String(req.socket.remoteAddress).replace(/^::ffff:/, '');
  return {
    settings: systemSettings.view(),
    listening: { host: listener.host, port: listener.port },
    fellBack: listener.fellBack,
    trial: listener.status(),
    // How this browser reaches rconsole, for the proxy field's hints.
    via: { address: direct, forwarded: Boolean(req.headers['x-forwarded-for']), trusted: fromTrustedProxy(req) },
    untrustedProxy: proxyCheck().length ? untrustedProxy.address : null,
    // Set in /etc/rconsole.env only: paths the sandbox is built around, and
    // safeguards that root-owned units read.
    fixed: {
      mcDir: config.mcDir,
      serversDir: config.serversDir,
      backupDir: config.backupDir,
      stateDir: config.stateDir,
      mcService: config.mcService,
      jobRunner: config.jobRunner,
      rconFirewall: !/^(off|false|0|no)$/i.test(process.env.RCON_FIREWALL || ''),
      signedUpdates: Boolean(process.env.SELF_UPDATE_SIGNERS),
    },
  };
}

route('GET', /^\/api\/system$/, (req) => systemView(req));

route('PUT', /^\/api\/system$/, async (req) => {
  const body = await readJson(req);
  const { set = {}, reset = [] } = body;
  const next = systemSettings.next({ set, reset });
  const v = next.values;

  // Don't let the change lock out the admin making it.
  const me = users.get(req.user);
  const roles = config.require2faRoles(v.require2fa);
  if (next.changed.includes('require2fa')) {
    if (me?.hash && !me.totp && roles.includes(req.role)) throw httpError(400, `Set up two-factor sign-in for your own account first (on the server: node cli.js user totp ${req.user}); otherwise this locks you out at your next sign-in.`);
    const without = Object.entries(users.load()).filter(([n, u]) => u.hash && !u.totp && roles.includes(users.roleOf(n))).map(([n]) => n);
    if (without.length && !body.confirm) throw httpError(409, `${without.join(', ')} ${without.length === 1 ? "doesn't" : "don't"} have two-factor sign-in yet and won't be able to sign in until ${without.length === 1 ? 'it is' : 'they are'} set up on the server (node cli.js user totp <name>).`, { confirm: '2fa' });
  }
  if (next.changed.includes('trustProxy') && !body.confirm) {
    const direct = String(req.socket.remoteAddress).replace(/^::ffff:/, '');
    if (req.headers['x-forwarded-for'] && !v.trustProxy.includes(direct)) throw httpError(409, `You're connected through ${direct}, which won't be trusted any more: everyone will share one sign-in lockout, and secure cookies and HSTS go off.`, { confirm: 'proxy' });
  }

  // A new address starts its trial first, so a port that can't be opened
  // fails the whole change before anything is saved.
  const listenSet = Object.fromEntries(Object.entries(set).filter(([k]) => LISTEN_KEYS.has(k)));
  const listenReset = reset.filter((k) => LISTEN_KEYS.has(k));
  let trial = null;
  if ((Object.keys(listenSet).length || listenReset.length) && (v.webHost !== listener.host || v.webPort !== listener.port)) {
    trial = await listener.trial(v.webHost, v.webPort);
    pendingListen = { set: listenSet, reset: listenReset, user: req.user };
  }

  // Everything else: saved and applied now. The address keys are saved
  // here only when the address stays the same (env file ↔ saved).
  const keep = (k) => !LISTEN_KEYS.has(k) || !trial;
  const rest = systemSettings.next({ set: Object.fromEntries(Object.entries(set).filter(([k]) => keep(k))), reset: reset.filter(keep) });
  if (JSON.stringify(rest.saved) !== JSON.stringify(systemSettings.saved)) {
    systemSettings.save(rest.saved);
    applySystem(rest.values);
    if (rest.changed.length) log(`${req.user}: system settings ${rest.changed.join(', ')}`);
  }
  return { ok: true, changed: next.changed, ...systemView(req), trial: trial || listener.status() };
});

route('DELETE', /^\/api\/system\/trial$/, async () => {
  await listener.cancel(`cancelled by an admin`);
  pendingListen = null;
  return { ok: true };
});

async function confirmListen(req) {
  const { token } = await readJson(req);
  const { host, port } = listener.confirm(token, req.socket.server);
  const p = pendingListen || { set: { webHost: host, webPort: port }, reset: [] };
  pendingListen = null;
  systemSettings.save(systemSettings.next(p).saved);
  [config.webHost, config.webPort] = [host, port];
  audit.record({ user: p.user || 'unknown', ip: clientIp(req), action: 'web address', target: `${host}:${port} confirmed` });
  return { ok: true, host, port };
}

// Settings → Account: a local account changes its own password. The current
// password proves it's the owner (not someone at an unlocked screen); wrong
// guesses count toward the sign-in lockout. Every other session ends; this
// one gets a fresh cookie.
route('POST', /^\/api\/me\/password$/, async (req, res) => {
  const { current, password } = await readJson(req);
  const ip = clientIp(req);
  const keys = [`ip:${ip}`, `user:${ip}|${req.user}`];
  const u = users.get(req.user);
  if (!u?.hash) throw httpError(409, 'This account signs in with single sign-on; change the password there.');
  const wait = throttle.blocked(...keys);
  if (wait) throw httpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} min.`, { 'Retry-After': wait });
  if (!(await verifyPassword(String(current || '').slice(0, 1024), u.hash))) {
    throttle.fail(...keys);
    throw httpError(403, 'The current password is wrong.');
  }
  if (String(password || '') === String(current)) throw httpError(400, 'Choose a password different from the current one.');
  try {
    await users.setPassword(req.user, String(password || '').slice(0, 1024));
  } catch (err) {
    throw httpError(400, err.message);
  }
  throttle.reset(...keys);
  sessions.destroy(cookies(req)[COOKIE]);
  res.setHeader('Set-Cookie', sessionCookie(req, sessions.create(req.user), COOKIE_MAX_AGE));
  log(`auth: ${req.user} changed their password`);
  return { ok: true };
});

route('GET', /^\/api\/me$/, (req) => {
  const s = sessions.get(cookies(req)[COOKIE]);
  const u = users.get(req.user);
  return {
    user: req.user,
    role: req.role,
    via: s?.via || 'password',
    name: u?.sso?.name || null,
    auth: {
      sso: oidc ? { name: sso.name, issuer: sso.issuer, groups: sso.groups, sessionHours: sso.sessionHours } : null,
      local: sso.localLogin,
    },
  };
});
route('POST', /^\/api\/logout$/, logout, false);

route('POST', /^\/api\/command$/, async (req) => {
  const { command } = await readJson(req);
  const cmd = String(command || '').trim().replace(/^\//, '');
  if (!cmd) throw httpError(400, 'Missing command');
  if (cmd.length > 1400) throw httpError(400, 'Command too long');
  if (req.role === 'moderator' && !MODERATOR_COMMANDS.has(commandName(cmd))) throw httpError(403, `Moderators can't run /${commandName(cmd)}`);
  if (req.role === 'moderator' && commandName(cmd) === 'whitelist' && /^\S+\s+(on|off|reload)\b/i.test(cmd)) throw httpError(403, 'Moderators can add and remove players, not switch the whitelist');
  log(`${req.user}: /${cmd}`);
  const output = await rcon.send(cmd);
  stats.invalidate(); // the header shows the effect (time set, kick…) on the next poll
  return { output };
});

// Web chat: a message to everyone or one player, shown in game as
// "[Web] name: text". tellraw, so the text can't run commands or click events.
route('POST', /^\/api\/chat$/, async (req) => {
  const { message, to } = await readJson(req);
  const text = String(message || '').replace(/[\u0000-\u001f\u007f§]/g, ' ').trim();
  if (!text) throw httpError(400, 'Type a message');
  if (text.length > 256) throw httpError(400, 'Messages are limited to 256 characters');
  if (to && !/^[A-Za-z0-9_]{1,16}$/.test(String(to))) throw httpError(400, 'Invalid player name');
  const parts = [
    { text: to ? '[Web → you] ' : '[Web] ', color: '#a78bfa' },
    { text: req.user, color: 'white', bold: false },
    { text: `: ${text}`, color: to ? 'gray' : 'white', italic: Boolean(to) },
  ];
  const reply = await rcon.send(`tellraw ${to || '@a'} ${JSON.stringify(parts)}`);
  if (to && /no player was found/i.test(reply)) throw httpError(404, `${to} isn't online`);
  log(`chat: ${req.user}${to ? ` → ${to}` : ''}: ${text}`);
  return { ok: true, at: new Date().toISOString(), user: req.user, to: to || null, text };
});

route('GET', /^\/api\/status$/, async () => ({
  ...(await stats.get()),
  power: await power.state(),
  maintenance: { enabled: maintenance.state().enabled, since: maintenance.state().since ?? null },
  restart: { remaining: countdown.remaining, verb: countdown.verb },
  backup: backups.state,
  update: updates.state,
  op: ops.state,
  pending: await pending.list(),
  self: selfUpdate.summary(),
  security: scanners.summary(),
  problems: await problems.summary().catch(() => null),
  platform: (({ id, name, family, mcVersion, build, loaderVersion, addons, updates: auto }) => ({ id, name, family, mcVersion, build, loaderVersion, addons: addons?.kind || null, updates: Boolean(auto) }))(platform()),
}));

// --- servers rconsole installs (SERVERS_DIR) ------------------------------------
// Everything but reading is admin-only (the default for non-GET routes).

route('GET', /^\/api\/servers$/, async () => {
  const list = await servers.list();
  // Game ports in use, so the form suggests a free one.
  const usedPorts = list.map((s) => s.port);
  if (legacyServer && !config.activeServer) usedPorts.push(Number((await readProperties(config.mcDir))['server-port']) || 25565);
  return { dir: config.serversDir, active: config.activeServer, attached: legacyServer && !config.activeServer, servers: list, usedPorts, distributions: distributions.list(), op: serverOps.state, memTotalMb: servers.memTotalMb() };
});

// Publisher lists change a few times a day; asked at most every 10 minutes.
const catalogCache = new Map();
async function catalog(key, fn) {
  const hit = catalogCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  const value = await fn();
  catalogCache.set(key, { at: Date.now(), value });
  return value;
}

route('GET', /^\/api\/distributions\/([a-z]+)\/versions$/, async (req, res, [id]) => {
  try {
    return { versions: await catalog(`v:${id}`, () => distributions.versions(id)) };
  } catch (err) {
    throw httpError(/Unknown/.test(err.message) ? 404 : 502, err.message);
  }
});

route('GET', /^\/api\/distributions\/([a-z]+)\/versions\/([0-9.]+)\/builds$/, async (req, res, [id, version]) => {
  try {
    return { builds: (await catalog(`b:${id}:${version}`, () => distributions.builds(id, version))).slice(0, 50) };
  } catch (err) {
    throw httpError(/Unknown|Invalid/.test(err.message) ? 400 : 502, err.message);
  }
});

route('POST', /^\/api\/servers$/, async (req) => {
  const b = await readJson(req);
  const wish = {
    id: b.id, name: b.name, distribution: b.distribution, version: b.version, build: b.build ?? null, memoryMb: b.memoryMb, port: b.port, flags: b.flags, autostart: b.autostart === true, eula: b.eula === true,
    proxy: b.proxy || null, recommended: b.recommended !== false, owner: b.owner || null, portLock: b.portLock === true, extraPorts: b.extraPorts ?? [],
  };
  return [202, servers.create(wish, { user: req.user, start: b.start !== false, force: b.force === true })];
});

route('PATCH', /^\/api\/servers\/([a-z0-9-]+)$/, async (req, res, [id]) => {
  const b = await readJson(req);
  return [202, servers.configure(id, { memoryMb: b.memoryMb, flags: b.flags, autostart: b.autostart, portLock: b.portLock, extraPorts: b.extraPorts }, { user: req.user, force: b.force === true })];
});

route('POST', /^\/api\/servers\/([a-z0-9-]+)\/power$/, async (req, res, [id]) => [202, await servers.action(id, (await readJson(req)).action, { user: req.user })]);

route('POST', /^\/api\/servers\/([a-z0-9-]+)\/console$/, async (req, res, [id]) => {
  await servers.send(id, (await readJson(req)).command);
  return { ok: true };
});

// Shows another server in every view: rconsole restarts onto it.
route('POST', /^\/api\/servers\/([a-z0-9-]+)\/show$/, async (req, res, [id]) => {
  const i = servers.get(id);
  if (i.kind !== 'server') throw httpError(400, 'A proxy has no worlds or players to show');
  if (id === config.activeServer) throw httpError(409, `${id} is already shown`);
  if (ops.busy() || updates.running) throw httpError(409, 'Wait until the running operation or update has finished');
  active.setActive(config.stateDir, id);
  log(`servers: ${req.user} switched rconsole to ${id}; restarting`);
  restartWhenIdle();
  return { ok: true, restarting: true };
});

route('DELETE', /^\/api\/servers\/([a-z0-9-]+)$/, async (req, res, [id]) => [202, servers.remove(id, { archive: new URL(req.url, 'http://x').searchParams.get('archive') !== '0', user: req.user })]);

// --- server power & maintenance ---------------------------------------------

const delayOf = (v, def = 60) => {
  const s = v === undefined ? def : Number(v);
  if (!Number.isFinite(s) || s < 0 || s > 3600) throw httpError(400, 'Delay must be 0-3600 seconds');
  return Math.round(s);
};

route('POST', /^\/api\/server\/power$/, async (req) => {
  const { action, seconds } = await readJson(req);
  if (!['start', 'stop', 'restart'].includes(action)) throw httpError(400, 'action must be start, stop or restart');
  const st = await power.state();
  if (!st.available) throw httpError(409, `rconsole can't control ${config.mcService} (${st.error || 'unit not found'})`);
  log(`${req.user}: server ${action}`);
  if (action === 'start') {
    if (st.active === 'active') throw httpError(409, 'The server is already running');
    return [202, ops.start('Start the server', req.user, async (step) => {
      step('starting');
      await power.run('start');
    })];
  }
  if (st.active !== 'active') {
    if (action === 'stop') throw httpError(409, 'The server is not running');
    return [202, ops.start('Start the server', req.user, () => power.run('start'))];
  }
  const delay = delayOf(seconds);
  return [202, ops.start(action === 'stop' ? 'Stop the server' : 'Restart the server', req.user, async (step) => {
    step(`${action === 'stop' ? 'stopping' : 'restarting'} in ${delay}s`);
    await countdown.start(delay, `${action} by ${req.user}`, action === 'stop' ? { verb: 'stopping', finish: () => power.run('stop') } : {});
  })];
});

route('POST', /^\/api\/maintenance$/, async (req) => {
  const { enabled, message } = await readJson(req);
  return enabled ? maintenance.enable({ user: req.user, message }) : maintenance.disable({ user: req.user });
});

// --- settings (server.properties) ------------------------------------------

route('GET', /^\/api\/settings$/, async () => {
  const values = await readProperties(config.mcDir);
  const editable = new Set(settingsSchema.EDITABLE.map((e) => e.key));
  const worldKeys = new Set(settingsSchema.WORLD_KEYS.map((e) => e.key));
  return {
    schema: settingsSchema.EDITABLE.map(({ live, ...spec }) => ({ ...spec, live: Boolean(live), value: values[spec.key] ?? null })),
    other: Object.entries(values)
      .filter(([k]) => !editable.has(k) && !worldKeys.has(k))
      .map(([key, value]) => ({ key, value: settingsSchema.SECRET_KEYS.has(key) ? (value ? '••••••••' : '') : value })),
    pending: await pending.list(),
  };
});

route('POST', /^\/api\/settings$/, async (req) => {
  const { set } = await readJson(req);
  let updates;
  try {
    updates = settingsSchema.normalizeAll(set);
  } catch (err) {
    throw httpError(400, err.message);
  }
  const current = await readProperties(config.mcDir);
  const changed = Object.fromEntries(Object.entries(updates).filter(([k, v]) => current[k] !== v));
  if (!Object.keys(changed).length) throw httpError(400, 'Nothing changed');
  await jobs.run('properties', { set: changed });
  log(`${req.user}: settings ${Object.entries(changed).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  const live = [];
  const restart = [];
  const running = (await power.state()).active === 'active';
  for (const [key, value] of Object.entries(changed)) {
    const spec = settingsSchema.EDITABLE.find((e) => e.key === key);
    if (spec.live && running) {
      try {
        await rcon.send(spec.live(value));
        live.push(key);
        continue;
      } catch {}
    }
    restart.push(key);
    pending.add(`setting ${key}`);
  }
  return { changed, live, restart };
});

// --- plugins -----------------------------------------------------------------

const pluginFile = (raw) => plugins.checkFile(decodeURIComponent(raw));

route('GET', /^\/api\/plugins$/, async (req) => plugins.list({ refresh: new URL(req.url, 'http://x').searchParams.has('refresh') }));
route('GET', /^\/api\/plugins\/search$/, async (req) => ({ results: await plugins.search(new URL(req.url, 'http://x').searchParams.get('q')) }));
route('POST', /^\/api\/plugins$/, async (req) => {
  const { projectId } = await readJson(req);
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(String(projectId || ''))) throw httpError(400, 'Invalid project');
  return plugins.install(projectId, req.user);
});
route('POST', /^\/api\/plugins\/([^/]+)\/update$/, async (req, res, [f]) => plugins.update(pluginFile(f), req.user));
route('POST', /^\/api\/plugins\/([^/]+)\/toggle$/, async (req, res, [f]) => {
  const { enabled } = await readJson(req);
  return plugins.change('plugin-toggle', pluginFile(f), { enabled: Boolean(enabled) }, req.user);
});
route('POST', /^\/api\/plugins\/([^/]+)\/rollback$/, async (req, res, [f]) => plugins.change('plugin-rollback', pluginFile(f), {}, req.user));
route('DELETE', /^\/api\/plugins\/([^/]+)$/, async (req, res, [f]) => plugins.change('plugin-remove', pluginFile(f), {}, req.user));

// --- worlds ---------------------------------------------------------------------

route('GET', /^\/api\/worlds$/, async () => ({ ...(await worlds.list()), op: ops.state }));
route('POST', /^\/api\/worlds$/, async (req) => {
  const { name, seed, type, seconds } = await readJson(req);
  return [202, worlds.create({ name: String(name || '').trim(), seed, type, seconds: delayOf(seconds), user: req.user })];
});
route('POST', /^\/api\/worlds\/([\w-]+)\/activate$/, async (req, res, [name]) => {
  const { seconds } = await readJson(req);
  return [202, worlds.activate(name, { seconds: delayOf(seconds), user: req.user })];
});
// Pre-generates the active world with the Chunky plugin, so players
// exploring later don't make the server generate chunks while they play
// (the biggest cause of lag on a new world).
const PREGEN_RADII = [1000, 2000, 3000, 5000, 10000];
route('POST', /^\/api\/worlds\/([\w-]+)\/pregenerate$/, async (req, res, [name]) => {
  const { radius } = await readJson(req);
  if (!PREGEN_RADII.includes(Number(radius))) throw httpError(400, `radius must be one of ${PREGEN_RADII.join(', ')}`);
  const { active } = await worlds.list();
  if (name !== active) throw httpError(409, 'Only the active world can be pre-generated (the server must have it loaded)');
  const first = await rcon.send(`chunky world ${name}`);
  if (/unknown (or incomplete )?command|unknown command/i.test(first)) throw httpError(409, 'Chunky is not installed. Install it under Plugins (search "Chunky"), restart, then try again.');
  for (const cmd of ['chunky spawn', `chunky radius ${Number(radius)}`, 'chunky start']) await rcon.send(cmd);
  log(`${req.user}: pre-generating ${name} with Chunky, radius ${radius}`);
  return { started: true, world: name, radius: Number(radius) };
});

route('DELETE', /^\/api\/worlds\/([\w-]+)$/, async (req, res, [name]) => {
  const archive = new URL(req.url, 'http://x').searchParams.get('archive') !== '0';
  return [202, worlds.remove(name, { archive, user: req.user })];
});

route('GET', /^\/api\/access$/, async (req) => forRole(req, await readAccess(config.mcDir)));

route('GET', /^\/api\/backups$/, async () => ({ dir: config.backupDir, keep: config.backupKeep, files: await backups.list(), state: backups.state }));

route('POST', /^\/api\/backups$/, async (req) => {
  const { world } = await readJson(req).catch(() => ({}));
  if (world !== undefined && !require('./lib/names').isWorldName(String(world))) throw httpError(400, 'Invalid world name');
  log(`${req.user}: backup requested${world ? ` (${world})` : ''}`);
  backups.run(world).catch(() => {}); // progress is reported through state
  return [202, { state: backups.state }];
});

route('POST', /^\/api\/backups\/([^/]+)\/restore$/, async (req, res, [name]) => {
  const { mode, target, seconds } = await readJson(req);
  if (!['replace', 'new'].includes(mode)) throw httpError(400, 'mode must be replace or new');
  backups.filePath(decodeURIComponent(name));
  return [202, worlds.restore(decodeURIComponent(name), { mode, target: target ? String(target).trim() : undefined, seconds: delayOf(seconds), user: req.user })];
});

route('GET', /^\/api\/backups\/([^/]+)$/, async (req, res, [name]) => {
  const file = backups.filePath(decodeURIComponent(name));
  const stat = await fs.promises.stat(file);
  log(`${req.user}: downloading ${path.basename(file)}`);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': file.endsWith('.zst') ? 'application/zstd' : 'application/gzip',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
  });
  // pipeline: a read error ends the download instead of leaving it hanging.
  require('stream').pipeline(fs.createReadStream(file), res, (err) => err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && log(`download ${path.basename(file)}: ${err.message}`));
  return null;
});

route('DELETE', /^\/api\/backups\/([^/]+)$/, async (req, res, [name]) => {
  await backups.remove(decodeURIComponent(name));
  log(`${req.user}: deleted backup ${name}`);
  return { ok: true };
});

route('POST', /^\/api\/restart$/, async (req) => {
  const { seconds } = await readJson(req);
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0 || s > 3600) throw httpError(400, 'seconds must be 0-3600');
  countdown.start(s, `manual by ${req.user}`).catch((err) => log(`restart: ${err.message}`));
  return { remaining: countdown.remaining };
});

route('DELETE', /^\/api\/restart$/, async (req) => {
  log(`${req.user}: cancelled restart`);
  return { cancelled: countdown.cancel() };
});

route('GET', /^\/api\/updates$/, async (req) => updates.overview({ refresh: new URL(req.url, 'http://x').searchParams.has('refresh') }));

route('GET', /^\/api\/updates\/builds$/, async (req) => ({
  builds: await updates.builds(new URL(req.url, 'http://x').searchParams.get('version')),
}));

route('POST', /^\/api\/updates$/, async (req) => {
  const { version, build, rollback, backup, restartSeconds } = await readJson(req);
  const b = typeof build === 'string' && !/^\d+$/.test(build) ? build : build == null || build === '' ? null : Number(build);
  return [202, updates.start({ version: String(version || ''), build: b, rollback: Boolean(rollback), backup: backup !== false, restartSeconds, user: req.user })];
});

route('GET', /^\/api\/tasks$/, async () => ({ tasks: scheduler.list() }));
route('POST', /^\/api\/tasks$/, async (req) => {
  const task = await scheduler.create(await readJson(req));
  log(`${req.user}: created task ${task.type} ${task.time}`);
  return [201, task];
});
route('PATCH', /^\/api\/tasks\/([\w-]+)$/, async (req, res, [id]) => scheduler.update(id, await readJson(req)));
route('DELETE', /^\/api\/tasks\/([\w-]+)$/, async (req, res, [id]) => {
  await scheduler.remove(id);
  log(`${req.user}: deleted task ${id}`);
  return { ok: true };
});
route('POST', /^\/api\/tasks\/([\w-]+)\/run$/, async (req, res, [id]) => {
  scheduler.get(id);
  log(`${req.user}: ran task ${id}`);
  scheduler.run(id).catch(() => {}); // restarts and backups can take minutes
  return [202, { ok: true }];
});


// ---------------------------------------------------------------------------
// Prometheus (/metrics, bearer token) and the map proxy (/map/ -> MAP_URL)
// ---------------------------------------------------------------------------

function tokenMatches(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

async function serveMetrics(req, res) {
  if (!config.metricsToken) return send(res, 404, { error: 'Turn on Prometheus metrics under Settings → System to enable /metrics' });
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ') || !tokenMatches(auth.slice(7), config.metricsToken)) {
    return send(res, 401, { error: 'Bearer token required' }, undefined, { 'WWW-Authenticate': 'Bearer' });
  }
  try {
    send(res, 200, await prom.render({ metrics, stats, power, backups, maintenance, selfUpdate, updates, platform }), 'text/plain; version=0.0.4; charset=utf-8');
  } catch (err) {
    send(res, 500, { error: err.message });
  }
}

// The map (squaremap, BlueMap...) runs its own small web server; it's only
// reachable through rconsole, after sign-in. The map shows player-controlled
// text, so it must not be able to act as the signed-in admin: rconsole frames
// it in a sandbox without allow-same-origin (no access to rconsole's page,
// cookies or API), and the proxy authenticates by a per-session token in the
// path instead of the cookie. squaremap uses relative URLs, so the token rides
// along on every tile and script request.
// `sandbox` keeps the map in an opaque origin even when opened in its own tab.
// rconsole's own origin, spelled out: in a sandboxed (opaque-origin) page
// Safari matches 'self' against nothing, which blocks the map's own requests
// and even the framing. Falls back to 'self' if the host header looks odd.
function selfOrigin(req) {
  const host = fromTrustedProxy(req) && req.headers['x-forwarded-host'] ? req.headers['x-forwarded-host'] : req.headers.host;
  if (!/^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?$/.test(String(host || ''))) return "'self'";
  return `'self' ${isHttps(req) ? 'https' : 'http'}://${host}`;
}
const mapCsp = (req) => {
  const me = selfOrigin(req);
  return `sandbox allow-scripts allow-popups; default-src ${me} 'unsafe-inline' 'unsafe-eval' data: blob:; img-src ${me} data: blob:; connect-src ${me}; frame-ancestors ${me}; base-uri ${me}; form-action 'none'`;
};

// Errors show inside the Map tab's frame as a short page (a JSON reply with
// rconsole's frame-ancestors 'none' would only leave a white frame).
function mapError(req, res, status, message) {
  const esc = String(message).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const page = `<!doctype html><meta charset="utf-8"><title>Map</title><style>body{margin:0;display:grid;place-items:center;height:100vh;font:14px/1.5 system-ui,sans-serif;background:#111;color:#bbb}p{max-width:34em;padding:0 24px;text-align:center}b{color:#eee}</style><p><b>The map isn't available.</b><br>${esc}</p>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': `sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors ${selfOrigin(req)}`,
  });
  res.end(page);
}
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'set-cookie', 'content-security-policy', 'x-frame-options', 'strict-transport-security', 'access-control-allow-origin', 'access-control-allow-credentials']);
const mapTokens = new Map(); // token -> session cookie token
const MAP_TOKEN_RE = /^\/map\/([A-Za-z0-9_-]{32})(\/.*)$/;

function mapToken(req) {
  const session = cookies(req)[COOKIE];
  for (const [t, s] of mapTokens) if (s === session) return t;
  const t = crypto.randomBytes(24).toString('base64url');
  mapTokens.set(t, session);
  return t;
}

// Valid while the session that asked for it is.
// Same checks as the cookie: ends with the session, and with a password or
// 2FA change of its user.
// Links of sessions that ended (sign-out, expiry) are dropped regularly.
setInterval(() => {
  for (const t of mapTokens.keys()) mapSessionUser(t);
}, 10 * 60 * 1000).unref();

function mapSessionUser(token) {
  const user = mapTokens.has(token) ? sessionUser(mapTokens.get(token)) : null;
  if (!user) mapTokens.delete(token);
  return user;
}

// MAP_URL wins; otherwise the map chosen in the Map tab (state/map.json).
const MAP_FILE = path.join(config.stateDir, 'map.json');
let savedMapUrl = (() => {
  try {
    const { url } = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
    return mapDetect.validMapUrl(url) ? url : '';
  } catch {
    return '';
  }
})();
function mapUrl() {
  return config.mapUrl || savedMapUrl;
}
function saveMapUrl(url) {
  fs.writeFileSync(`${MAP_FILE}.tmp`, JSON.stringify({ url }), { mode: 0o600 });
  fs.renameSync(`${MAP_FILE}.tmp`, MAP_FILE);
  savedMapUrl = url;
}

// The map runs in a sandbox without allow-same-origin (so it can't reach
// rconsole's page, cookies or API), where reading localStorage,
// sessionStorage or document.cookie throws. BlueMap reads localStorage while
// it starts and then shows "Failed to load BlueMap webapp!". Pages from the
// map get these in memory instead, for as long as the tab is open.
const MAP_SHIM = `<script>(function(){function mem(){var m=new Map();return{getItem:function(k){return m.has(String(k))?m.get(String(k)):null},setItem:function(k,v){m.set(String(k),String(v))},removeItem:function(k){m.delete(String(k))},clear:function(){m.clear()},key:function(i){return Array.from(m.keys())[i]||null},get length(){return m.size}}}['localStorage','sessionStorage'].forEach(function(n){try{window[n].getItem('x')}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(e2){}}});try{document.cookie}catch(e){var c='';try{Object.defineProperty(Document.prototype,'cookie',{get:function(){return c},set:function(v){c=String(v).split(';')[0]},configurable:true})}catch(e2){}}})();</script>`;
function injectMapShim(html) {
  const m = html.match(/<head[^>]*>/i);
  return m ? html.slice(0, m.index + m[0].length) + MAP_SHIM + html.slice(m.index + m[0].length) : MAP_SHIM + html;
}
function decode(buf, encoding) {
  if (/\bbr\b/.test(encoding || '')) return zlib.brotliDecompressSync(buf);
  if (/gzip/.test(encoding || '')) return zlib.gunzipSync(buf);
  if (/deflate/.test(encoding || '')) return zlib.inflateSync(buf);
  return buf;
}

function proxyMap(req, res, pathname) {
  if (!mapUrl()) return mapError(req, res, 404, 'No map is configured: choose one in the Map tab.');
  const m = pathname.match(MAP_TOKEN_RE);
  if (!m || !mapSessionUser(m[1])) return mapError(req, res, 401, 'This map link has expired. Reopen the Map tab in rconsole.');
  pathname = `/map${m[2]}`;
  if (req.method !== 'GET' && req.method !== 'HEAD') return mapError(req, res, 405, 'The map is read-only.');
  const target = new URL(mapUrl());
  const search = new URL(req.url, 'http://x').search;
  const upstream = http.request({
    host: target.hostname,
    port: target.port || 80,
    method: req.method,
    path: `${target.pathname.replace(/\/$/, '')}${pathname.slice(4)}${search}`,
    // No cookies: the session cookie stays with rconsole.
    headers: { accept: req.headers.accept || '*/*', 'accept-encoding': req.headers['accept-encoding'] || '', 'if-none-match': req.headers['if-none-match'] || '', 'if-modified-since': req.headers['if-modified-since'] || '', 'user-agent': 'rconsole-map-proxy' },
    timeout: 15000,
  }, (up) => {
    const headers = Object.fromEntries(Object.entries(up.headers).filter(([k]) => !HOP.has(k)));
    const html = /^text\/html/i.test(up.headers['content-type'] || '') && req.method === 'GET' && up.statusCode === 200;
    if (html) {
      // Pages get the storage shim (see MAP_SHIM); their length changes.
      delete headers['content-length'];
      delete headers['content-encoding'];
      delete headers.etag;
    }
    res.writeHead(up.statusCode, {
      ...headers,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': mapCsp(req),
      // The sandboxed frame has an opaque origin; its fetch()es are CORS.
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': html ? 'no-store' : up.headers['cache-control'] || 'private, max-age=60',
    });
    if (!html) return up.pipe(res);
    const chunks = [];
    let size = 0;
    up.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) return up.destroy(new Error('page too large'));
      chunks.push(c);
    });
    up.on('end', () => {
      let body;
      try {
        body = decode(Buffer.concat(chunks), up.headers['content-encoding']).toString('utf8');
      } catch {
        return res.destroy();
      }
      res.end(injectMapShim(body));
    });
    up.on('error', () => res.destroy());
  });
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', (err) => {
    if (!res.headersSent) mapError(req, res, 502, `rconsole can't reach the map server at ${mapUrl()} (${err.code || err.message}). Is the map plugin running, and does the map address match its port?`);
    else res.destroy();
  });
  upstream.end();
  return undefined;
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

async function handle(req, res, handler, params = [], onDone) {
  try {
    const result = await handler(req, res, params);
    if (result === null) return; // handler wrote the response itself
    const [status, body] = Array.isArray(result) ? result : [200, result];
    send(res, status, body);
    onDone?.(status);
  } catch (err) {
    const status = err.status || (err instanceof URIError ? 400 : err.code === 'ENOENT' ? 404 : 502); // URIError: malformed %-encoding in the path
    onDone?.(status, err.message);
    const headers = err.extra?.['Retry-After'] ? { 'Retry-After': err.extra['Retry-After'] } : {};
    const body = { error: err.message, ...(err.extra?.needCode ? { needCode: true } : {}), ...(err.extra?.confirm ? { confirm: err.extra.confirm } : {}) };
    if (!res.headersSent) send(res, status, body, undefined, headers);
    else res.destroy();
  }
}

const onRequest = (req, res) => {
  // Anything a handler throws ends this request, never the process.
  dispatch(req, res).catch((err) => {
    log(`http: ${req.method} ${String(req.url).slice(0, 200)}: ${err.stack || err.message}`);
    if (!res.headersSent) send(res, err instanceof URIError ? 400 : 500, { error: err instanceof URIError ? 'Bad request' : 'Internal error' });
    else res.destroy();
  });
};
const listener = new Listener({ handler: onRequest, log });

async function dispatch(req, res) {
  // Only over HTTPS (the proxy says so): browsers ignore it on plain HTTP,
  // and it must not pin a host that is reached without TLS.
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  noteProxy(req);
  const { pathname } = new URL(req.url, 'http://localhost');
  const isRead = req.method === 'GET' || req.method === 'HEAD';

  // One-tap notification actions come from the ntfy app, without a session or
  // same-origin headers; the single-use token is the credential.
  const act = req.method === 'POST' && pathname.match(/^\/api\/notify\/act\/([A-Za-z0-9_-]{32})$/);
  if (act) return handle(req, res, () => notify.act(act[1]).then((r) => ({ ok: true, ...r })).catch((err) => {
    audit.record({ user: 'ntfy', ip: clientIp(req), action: 'notification action', ok: false, error: err.message });
    throw err;
  }));
  if (!isRead && !sameOrigin(req)) return send(res, 403, { error: 'Cross-origin request blocked' });

  if (isRead && PUBLIC_FILES[pathname]) return serveStatic(req, res, PUBLIC_FILES[pathname]);
  if (req.method === 'POST' && pathname === '/api/login') return handle(req, res, login);
  if (req.method === 'GET' && pathname === '/api/auth-config') return send(res, 200, { sso: oidc ? { name: sso.name } : null, local: sso.localLogin });
  if (req.method === 'GET' && pathname === '/auth/oidc/start') return ssoStart(req, res);
  if (req.method === 'GET' && pathname === '/auth/oidc/callback') return ssoCallback(req, res);
  if (req.method === 'GET' && pathname === '/healthz') return send(res, 200, { ok: true });
  // The single-use token of an address trial is the credential: the new
  // address may not carry the session cookie (other port, plain HTTP).
  if (req.method === 'POST' && pathname === '/api/system/confirm') return handle(req, res, confirmListen);
  if (req.method === 'GET' && pathname === '/metrics') return serveMetrics(req, res);
  if (pathname.startsWith('/map/')) return proxyMap(req, res, pathname);

  req.user = currentUser(req);
  if (!req.user) {
    if (isRead && !pathname.startsWith('/api/')) return send(res, 302, '', 'text/plain', { Location: '/login' });
    return send(res, 401, { error: 'Not signed in' });
  }

  req.role = users.roleOf(req.user);
  if (isRead && APP_FILES[pathname]) return serveStatic(req, res, APP_FILES[pathname]);
  if (req.method === 'GET' && pathname === '/api/logs') return streamLogs(req, res);

  for (const { method, pattern, handler, audited } of routes) {
    const match = pathname.match(pattern);
    if (match && method === req.method) {
      const onDone = !isRead && audited ? (status, error) => auditRequest(req, pathname, status, error) : undefined;
      if (!roleAtLeast(req.role, requiredRole(req.method, pathname))) {
        onDone?.(403, 'not allowed for this role');
        return send(res, 403, { error: `Your role (${req.role}) can't do this` });
      }
      return handle(req, res, handler, match.slice(1), onDone);
    }
  }
  send(res, 404, { error: 'Not found' });
}

// A promise nobody handles is a bug to log, not a reason to sign everyone
// out and abort running operations.
process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.stack || err}`));

scheduler.load().then(() => {
  logTail.start();
  metrics.start();
  metrics.onSample((sample) => notify.onSample(sample, { stats, ops, countdown, backups }));
  // A server that goes down on its own with a failed systemd result crashed,
  // even when the log shows nothing (killed by the OOM killer, JVM abort).
  let wasUp = null;
  metrics.onSample(async (sample) => {
    const up = sample.up === 1;
    const planned = ops.state?.running || countdown.remaining != null;
    if (wasUp && !up && !planned) {
      const st = await power.state().catch(() => null);
      if (st?.available && (st.active === 'failed' || (st.result && st.result !== 'success'))) {
        problems.record({ title: 'Server stopped unexpectedly', message: `systemd reports ${st.result || st.active}${st.result === 'oom-kill' ? ': the system ran out of memory and killed it' : ''}.` });
      }
    }
    wasUp = up;
  });
  logTail.on('line', (line) => problems.onLogLine(line));
  setTimeout(() => (problems.ready = true), 5000).unref(); // after the tail's first read of old lines
  logTail.on('line', (line) => notify.onLogLine(line));
  const updateCheck = () => notify.checkUpdates({ updates, plugins, selfUpdate }).catch((err) => log(`notify: ${err.message}`));
  setTimeout(updateCheck, 5 * 60 * 1000).unref();
  setInterval(updateCheck, 24 * 3600 * 1000).unref();
  selfUpdate.startTimer(() => config.updateCheck);
  playerHistory.history().then((h) => scanners.seed(h)).catch((err) => log(`players: ${err.message}`)); // backfill from old logs
  logTail.on('line', (line) => scanners.onLogLine(line));
  logTail.on('line', (line) => {
    if (/ (joined|left) the game$| lost connection: /.test(line)) stats.invalidate('players');
  });
  servers.autostart().catch((err) => log(`servers: autostart: ${err.message}`));
  const envListen = systemFromEnv(process.env);
  listener.start(config.webHost, config.webPort, { host: envListen.webHost.value, port: envListen.webPort.value }).then(({ host, port }) => {
    [config.webHost, config.webPort] = [host, port];
    if (listener.fellBack) problems.record({ kind: 'host', severity: 'warning', title: 'Saved web address not available', message: `${listener.fellBack.error}. rconsole listens on ${host}:${port} from /etc/rconsole.env instead. Check Settings → System → Web access.` });
    log(`rconsole listening on http://${host}:${port}`);
    log(`RCON ${config.rconHost}:${config.rconPort}, server dir ${config.mcDir}, backups ${config.backupDir}, state ${config.stateDir}`);
    if (config.trustProxy.length) log(`trusting X-Forwarded-* from ${config.trustProxy.join(', ')}`);
    if (!users.count && !oidc) log('WARNING: no users yet. Create one with: node cli.js user add <name>');
    if (!sso.localLogin && !oidc) log('WARNING: LOCAL_LOGIN=off but single sign-on is not working: nobody can sign in. Fix the single sign-on settings or set LOCAL_LOGIN=on.');
    if (process.env.WEB_PASSWORD) log('NOTE: WEB_USER/WEB_PASSWORD are no longer used; manage users with cli.js');
  }).catch((err) => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    logTail.stop();
    metrics.stop();
    rcon.close();
    sessions.flush();
    listener.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref(); // open log streams keep the server alive
  });
}

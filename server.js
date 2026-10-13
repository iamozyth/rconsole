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
const { Offsite } = require('./lib/offsite');
const { Spark } = require('./lib/spark');
const { CommandCatalog } = require('./lib/commands');
const { SelfUpdate } = require('./lib/selfupdate');
const { Notify } = require('./lib/notify');
const prom = require('./lib/prom');
const crypto = require('crypto');
const { Users, Sessions, Throttle, verifyPassword, getDummyHash, verifyTotp, roleAtLeast } = require('./lib/auth');

if (!config.rconPassword) {
  console.error('Missing required environment variable RCON_PASSWORD');
  process.exit(1);
}

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const rcon = new Rcon({ host: config.rconHost, port: config.rconPort, password: config.rconPassword });
const logTail = new LogTail(path.join(config.mcDir, 'logs', 'latest.log'));
const stats = new Stats({ rcon, mcDir: config.mcDir });
const jobs = new Jobs({ backupDir: config.backupDir, runner: config.jobRunner, log });
const activeWorld = async () => (await readProperties(config.mcDir))['level-name'] || 'world';
const backups = new Backups({ rcon, jobs, backupDir: config.backupDir, keep: config.backupKeep, log, activeWorld });
const power = new Power({ unit: config.mcService, log });
const countdown = new Countdown({ rcon, log, power });
const ops = new Ops({ log });
const worlds = new Worlds({ mcDir: config.mcDir, stateDir: config.stateDir, jobs, backups, power, countdown, ops, rcon, log });
const maintenance = new Maintenance({ mcDir: config.mcDir, stateDir: config.stateDir, rcon, log });
const pending = new Pending({ stateDir: config.stateDir, power });
const platform = platformLib.detector(config.mcDir);
const updates = new Updates({ jobs, backups, countdown, mcDir: config.mcDir, mcJar: config.mcJar, log, platform, power, rcon });
const gameVersion = async () => (await updates.installed())?.version || null;
const plugins = new Plugins({ mcDir: config.mcDir, jobs, pending, log, gameVersion, platform });
const spark = new Spark({ mcDir: config.mcDir, rcon, plugins, log });
const commandCatalog = new CommandCatalog({ rcon, log });
const notify = new Notify({ stateDir: config.stateDir, log, publicUrl: config.publicUrl });
const selfUpdate = new SelfUpdate({ dir: __dirname, stateDir: config.stateDir, runner: config.jobRunner, log });
const audit = new Audit({ stateDir: config.stateDir, log, onRecord: (e) => notify.onAudit(e) });
// Operations run in the background after the request returned 202; record how they ended.
ops.onFinish = (st) => audit.record({ user: st.user, action: 'operation', target: st.label, ok: !st.error, ...(st.error ? { error: st.error } : {}) });
const metrics = new Metrics({ stats, power, stateDir: config.stateDir, log });
const playerHistory = new PlayerHistory({ mcDir: config.mcDir, stateDir: config.stateDir, log });
const scanners = new Scanners({ onAttempt: (a) => notify.onScanner(a) });
const offsite = new Offsite({
  stateDir: config.stateDir, backupDir: config.backupDir, log,
  onResult: (r) => !r.ok && notify.send('backup', { title: 'Offsite upload failed', message: `${r.file}\n\n${r.error}`, key: `offsite-${r.file}` }),
});
backups.onCreated = (file) => offsite.onBackup(file);
const problems = new Problems({ mcDir: config.mcDir, stateDir: config.stateDir, log, onProblem: (g) => notify.onProblem(g) });
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
const sessions = new Sessions();
const throttle = new Throttle();
const lastTotpStep = new Map(); // user -> last accepted TOTP step, blocks code replay

const COOKIE = 'rconsole_session';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

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
const load = (file, headers) => [fs.readFileSync(path.join(__dirname, 'public', file)), types[path.extname(file)], headers];

const PUBLIC_FILES = {
  '/login': load('login.html'),
  '/login.js': load('login.js'),
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

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  const payload = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
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

const isHttps = (req) => fromTrustedProxy(req) && req.headers['x-forwarded-proto'] === 'https';

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
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

function streamLogs(req, res) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  event('backlog', { lines: logTail.backlog, error: logTail.error });
  const onLine = (line) => event('line', line);
  const onStatus = (error) => event('status', { error });
  logTail.on('line', onLine);
  logTail.on('status', onStatus);
  const ping = setInterval(() => {
    // Also ends the stream once the session is gone (logout, password change).
    if (!currentUser(req)) return res.end();
    res.write(': ping\n\n');
  }, 15000);
  req.on('close', () => {
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
  const keys = [`ip:${ip}`, `user:${name}`];

  if (!users.count) throw httpError(503, 'No users configured yet. On the server run: node cli.js user add <name>');

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

  if (user.totp) {
    if (!code) return [401, { needCode: true }];
    const step = verifyTotp(user.totp, String(code).replace(/\s/g, ''));
    if (step === null || step <= (lastTotpStep.get(name) ?? -1)) {
      throttle.fail(...keys);
      log(`auth: wrong 2FA code for "${name}" from ${ip}`);
      audit.record({ user: name, ip, action: 'login', ok: false, error: 'wrong 2FA code' });
      throw httpError(401, 'Invalid code', { needCode: true });
    }
    lastTotpStep.set(name, step);
  }

  throttle.reset(...keys);
  const token = sessions.create(name);
  log(`auth: ${name} signed in from ${ip}`);
  audit.record({ user: name, ip, action: 'login' });
  res.setHeader('Set-Cookie', sessionCookie(req, token, COOKIE_MAX_AGE));
  return { user: name };
}

function logout(req, res) {
  const user = currentUser(req);
  sessions.destroy(cookies(req)[COOKIE]);
  if (user) {
    log(`auth: ${user} signed out`);
    audit.record({ user, ip: clientIp(req), action: 'logout' });
  }
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  return { ok: true };
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
  ['POST', /^\/api\/plugins$/, (p, b) => ['plugin install', b.projectId]],
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
  ['POST', /^\/api\/self-update$/, () => ['rconsole update', selfUpdate.summary().current]],
  ['POST', /^\/api\/problems\/seen$/, () => ['problems marked as seen', '']],
  ['PUT', /^\/api\/offsite$/, () => ['offsite settings', '']],
  ['POST', /^\/api\/chat$/, (p, b) => [b.to ? `whisper to ${b.to}` : 'chat', String(b.message || '').slice(0, 120)]],
  ['POST', /^\/api\/spark$/, (p, b) => [`spark ${b.kind === 'health' ? 'health report' : 'profile'}`, '']],
  ['POST', /^\/api\/offsite\/upload$/, (p, b) => ['offsite upload', b.file]],
  ['POST', /^\/api\/offsite\/download$/, (p, b) => ['offsite download', b.name]],
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
  ['POST', /^\/api\/chat$/, 'moderator'],
  ['GET', /^\/api\/players\/history$/, 'moderator'], // addresses of players
  ['GET', /^\/api\/audit$/, 'admin'],
  ['GET', /^\/api\/notify$/, 'admin'],
  ['GET', /^\/api\/offsite/, 'admin'],
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
route('POST', /^\/api\/notify$/, async (req) => notify.update(await readJson(req)));
route('POST', /^\/api\/notify\/test$/, async (req) => {
  if (!notify.config.url) throw httpError(409, 'Set the ntfy topic URL first');
  try {
    await notify.test(req.user);
  } catch (err) {
    throw httpError(502, `ntfy: ${err.message}`);
  }
  return { ok: true };
});
route('GET', /^\/api\/map$/, (req) => ({ configured: Boolean(config.mapUrl), src: config.mapUrl ? `/map/${mapToken(req)}/` : null }));
route('GET', /^\/api\/self-update$/, (req) => selfUpdate.overview({ refresh: new URL(req.url, 'http://x').searchParams.has('refresh') }));
route('POST', /^\/api\/self-update$/, async (req) => [202, await selfUpdate.start()]);
route('GET', /^\/api\/commands$/, (req) => commandCatalog.list({ refresh: new URL(req.url, 'http://x').searchParams.has('refresh') }));
route('GET', /^\/api\/metrics$/, (req) => metrics.series(new URL(req.url, 'http://x').searchParams.get('range') || '24h'));
route('GET', /^\/api\/players\/history$/, () => playerHistory.history());
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
route('GET', /^\/api\/problems$/, async (req) => problems.scan({ days: new URL(req.url, 'http://x').searchParams.get('days') }));
route('POST', /^\/api\/problems\/seen$/, async () => problems.markSeen());
route('GET', /^\/api\/logs\/search$/, async (req) => searchLogs(config.mcDir, Object.fromEntries(new URL(req.url, 'http://x').searchParams)));
route('GET', /^\/api\/audit$/, async (req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  return audit.query({ user: q.get('user') || '', action: q.get('action') || '', q: q.get('q') || '', failed: q.has('failed'), limit: Math.min(Number(q.get('limit')) || 200, 1000) });
});

route('GET', /^\/api\/me$/, (req) => ({ user: req.user, role: req.role }));
route('POST', /^\/api\/logout$/, logout, false);

route('POST', /^\/api\/command$/, async (req) => {
  const { command } = await readJson(req);
  const cmd = String(command || '').trim().replace(/^\//, '');
  if (!cmd) throw httpError(400, 'Missing command');
  if (cmd.length > 1400) throw httpError(400, 'Command too long');
  if (req.role === 'moderator' && !MODERATOR_COMMANDS.has(commandName(cmd))) throw httpError(403, `Moderators can't run /${commandName(cmd)}`);
  if (req.role === 'moderator' && commandName(cmd) === 'whitelist' && /^\S+\s+(on|off|reload)\b/i.test(cmd)) throw httpError(403, 'Moderators can add and remove players, not switch the whitelist');
  log(`${req.user}: /${cmd}`);
  return { output: await rcon.send(cmd) };
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
route('DELETE', /^\/api\/worlds\/([\w-]+)$/, async (req, res, [name]) => {
  const archive = new URL(req.url, 'http://x').searchParams.get('archive') !== '0';
  return [202, worlds.remove(name, { archive, user: req.user })];
});

route('GET', /^\/api\/access$/, () => readAccess(config.mcDir));

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
    'Content-Type': 'application/gzip',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
  });
  fs.createReadStream(file).pipe(res);
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
  return [202, updates.start({ version: String(version || ''), build: Number(build), rollback: Boolean(rollback), backup: backup !== false, restartSeconds, user: req.user })];
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
  if (!config.metricsToken) return send(res, 404, { error: 'Set METRICS_TOKEN to enable /metrics' });
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
const MAP_CSP = "sandbox allow-scripts allow-popups; default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'none'";
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
function mapSessionUser(token) {
  const user = mapTokens.has(token) ? sessionUser(mapTokens.get(token)) : null;
  if (!user) mapTokens.delete(token);
  return user;
}

function proxyMap(req, res, pathname) {
  if (!config.mapUrl) return send(res, 404, { error: 'No map configured (MAP_URL)' });
  const m = pathname.match(MAP_TOKEN_RE);
  if (!m || !mapSessionUser(m[1])) return send(res, 401, { error: 'Map link expired; reopen the Map tab' });
  pathname = `/map${m[2]}`;
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Read-only' });
  const target = new URL(config.mapUrl);
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
    res.writeHead(up.statusCode, {
      ...headers,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'SAMEORIGIN',
      'Content-Security-Policy': MAP_CSP,
      // The sandboxed frame has an opaque origin; its fetch()es are CORS.
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': up.headers['cache-control'] || 'private, max-age=60',
    });
    up.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', (err) => {
    if (!res.headersSent) send(res, 502, { error: `Map server unreachable at ${config.mapUrl}: ${err.message}` });
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
    const status = err.status || (err.code === 'ENOENT' ? 404 : 502);
    onDone?.(status, err.message);
    const headers = err.extra?.['Retry-After'] ? { 'Retry-After': err.extra['Retry-After'] } : {};
    const body = { error: err.message, ...(err.extra?.needCode ? { needCode: true } : {}) };
    if (!res.headersSent) send(res, status, body, undefined, headers);
    else res.destroy();
  }
}

const server = http.createServer(async (req, res) => {
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

  if (isRead && PUBLIC_FILES[pathname]) return send(res, 200, ...PUBLIC_FILES[pathname]);
  if (req.method === 'POST' && pathname === '/api/login') return handle(req, res, login);
  if (req.method === 'GET' && pathname === '/healthz') return send(res, 200, { ok: true });
  if (req.method === 'GET' && pathname === '/metrics') return serveMetrics(req, res);
  if (pathname.startsWith('/map/')) return proxyMap(req, res, pathname);

  req.user = currentUser(req);
  if (!req.user) {
    if (isRead && !pathname.startsWith('/api/')) return send(res, 302, '', 'text/plain', { Location: '/login' });
    return send(res, 401, { error: 'Not signed in' });
  }

  req.role = users.roleOf(req.user);
  if (isRead && APP_FILES[pathname]) return send(res, 200, ...APP_FILES[pathname]);
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
});

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
  selfUpdate.startTimer();
  playerHistory.history().then((h) => scanners.seed(h)).catch((err) => log(`players: ${err.message}`)); // backfill from old logs
  logTail.on('line', (line) => scanners.onLogLine(line));
  server.listen(config.webPort, config.webHost, () => {
    log(`rconsole listening on http://${config.webHost}:${config.webPort}`);
    log(`RCON ${config.rconHost}:${config.rconPort}, server dir ${config.mcDir}, backups ${config.backupDir}, state ${config.stateDir}`);
    if (config.trustProxy.length) log(`trusting X-Forwarded-* from ${config.trustProxy.join(', ')}`);
    if (!users.count) log('WARNING: no users yet. Create one with: node cli.js user add <name>');
    if (process.env.WEB_PASSWORD) log('NOTE: WEB_USER/WEB_PASSWORD are no longer used; manage users with cli.js');
  });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    logTail.stop();
    metrics.stop();
    rcon.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref(); // open log streams keep the server alive
  });
}

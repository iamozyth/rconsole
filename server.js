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
const { Users, Sessions, Throttle, verifyPassword, getDummyHash, verifyTotp } = require('./lib/auth');

if (!config.rconPassword) {
  console.error('Missing required environment variable RCON_PASSWORD');
  process.exit(1);
}

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const rcon = new Rcon({ host: config.rconHost, port: config.rconPort, password: config.rconPassword });
const logTail = new LogTail(path.join(config.mcDir, 'logs', 'latest.log'));
const stats = new Stats({ rcon, mcDir: config.mcDir });
const jobs = new Jobs({ backupDir: config.backupDir, runner: config.jobRunner });
const backups = new Backups({ rcon, jobs, backupDir: config.backupDir, keep: config.backupKeep, log });
const countdown = new Countdown({ rcon, log });
const updates = new Updates({ jobs, backups, countdown, mcDir: config.mcDir, mcJar: config.mcJar, log });
const scheduler = new Scheduler({ rcon, backups, countdown, stateDir: config.stateDir, log });
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
  '.woff2': 'font/woff2',
};
const IMMUTABLE = { 'Cache-Control': 'public, max-age=604800' };
const load = (file, headers) => [fs.readFileSync(path.join(__dirname, 'public', file)), types[path.extname(file)], headers];

const PUBLIC_FILES = {
  '/login': load('login.html'),
  '/login.js': load('login.js'),
  '/style.css': load('style.css'),
  '/favicon.svg': load('favicon.svg', IMMUTABLE),
  '/fonts/archivo.woff2': load('fonts/archivo.woff2', IMMUTABLE),
};
const APP_FILES = { '/': load('index.html'), '/app.js': load('app.js') };

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
    "default-src 'self'; img-src 'self' https://mc-heads.net; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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
function currentUser(req) {
  const token = cookies(req)[COOKIE];
  const s = sessions.get(token);
  if (!s) return null;
  const user = users.get(s.user);
  if (!user || Date.parse(user.changed || 0) > s.created) {
    sessions.destroy(token);
    return null;
  }
  return s.user;
}

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
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
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

async function login(req, res) {
  const { username, password, code } = await readJson(req);
  const name = String(username || '').trim().toLowerCase().slice(0, 64);
  const ip = clientIp(req);
  const keys = [`ip:${ip}`, `user:${name}`];

  if (!users.count) throw httpError(503, 'No users configured yet. On the server run: node cli.js user add <name>');

  const wait = throttle.blocked(...keys);
  if (wait) {
    log(`auth: blocked login for "${name}" from ${ip} (${wait}s left)`);
    throw httpError(429, `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} min.`, { 'Retry-After': wait });
  }

  const user = users.get(name);
  const ok = (await verifyPassword(String(password || '').slice(0, 1024), user?.hash ?? (await getDummyHash()))) && user;
  if (!ok) {
    throttle.fail(...keys);
    log(`auth: failed login for "${name}" from ${ip}`);
    throw httpError(401, 'Invalid username or password');
  }

  if (user.totp) {
    if (!code) return [401, { needCode: true }];
    const step = verifyTotp(user.totp, String(code).replace(/\s/g, ''));
    if (step === null || step <= (lastTotpStep.get(name) ?? -1)) {
      throttle.fail(...keys);
      log(`auth: wrong 2FA code for "${name}" from ${ip}`);
      throw httpError(401, 'Invalid code', { needCode: true });
    }
    lastTotpStep.set(name, step);
  }

  throttle.reset(...keys);
  const token = sessions.create(name);
  log(`auth: ${name} signed in from ${ip}`);
  res.setHeader('Set-Cookie', sessionCookie(req, token, COOKIE_MAX_AGE));
  return { user: name };
}

function logout(req, res) {
  const user = currentUser(req);
  sessions.destroy(cookies(req)[COOKIE]);
  if (user) log(`auth: ${user} signed out`);
  res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// API routes (all require a session)
// ---------------------------------------------------------------------------

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/me$/, (req) => ({ user: req.user }));
route('POST', /^\/api\/logout$/, logout);

route('POST', /^\/api\/command$/, async (req) => {
  const { command } = await readJson(req);
  const cmd = String(command || '').trim().replace(/^\//, '');
  if (!cmd) throw httpError(400, 'Missing command');
  if (cmd.length > 1400) throw httpError(400, 'Command too long');
  log(`${req.user}: /${cmd}`);
  return { output: await rcon.send(cmd) };
});

route('GET', /^\/api\/status$/, async () => ({
  ...(await stats.get()),
  restart: { remaining: countdown.remaining },
  backup: backups.state,
  update: updates.state,
}));

route('GET', /^\/api\/access$/, () => readAccess(config.mcDir));

route('GET', /^\/api\/backups$/, async () => ({ dir: config.backupDir, keep: config.backupKeep, files: await backups.list(), state: backups.state }));

route('POST', /^\/api\/backups$/, async (req) => {
  log(`${req.user}: backup requested`);
  backups.run().catch(() => {}); // progress is reported through state
  return [202, { state: backups.state }];
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
  countdown.start(s, `manual by ${req.user}`).catch(() => {});
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
// Dispatcher
// ---------------------------------------------------------------------------

async function handle(req, res, handler, params = []) {
  try {
    const result = await handler(req, res, params);
    if (result === null) return; // handler wrote the response itself
    const [status, body] = Array.isArray(result) ? result : [200, result];
    send(res, status, body);
  } catch (err) {
    const status = err.status || (err.code === 'ENOENT' ? 404 : 502);
    const headers = err.extra?.['Retry-After'] ? { 'Retry-After': err.extra['Retry-After'] } : {};
    const body = { error: err.message, ...(err.extra?.needCode ? { needCode: true } : {}) };
    if (!res.headersSent) send(res, status, body, undefined, headers);
    else res.destroy();
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const isRead = req.method === 'GET' || req.method === 'HEAD';

  if (!isRead && !sameOrigin(req)) return send(res, 403, { error: 'Cross-origin request blocked' });

  if (isRead && PUBLIC_FILES[pathname]) return send(res, 200, ...PUBLIC_FILES[pathname]);
  if (req.method === 'POST' && pathname === '/api/login') return handle(req, res, login);
  if (req.method === 'GET' && pathname === '/healthz') return send(res, 200, { ok: true });

  req.user = currentUser(req);
  if (!req.user) {
    if (isRead && !pathname.startsWith('/api/')) return send(res, 302, '', 'text/plain', { Location: '/login' });
    return send(res, 401, { error: 'Not signed in' });
  }

  if (isRead && APP_FILES[pathname]) return send(res, 200, ...APP_FILES[pathname]);
  if (req.method === 'GET' && pathname === '/api/logs') return streamLogs(req, res);

  for (const { method, pattern, handler } of routes) {
    const match = pathname.match(pattern);
    if (match && method === req.method) return handle(req, res, handler, match.slice(1));
  }
  send(res, 404, { error: 'Not found' });
});

scheduler.load().then(() => {
  logTail.start();
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
    rcon.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref(); // open log streams keep the server alive
  });
}

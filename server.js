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
const settingsSchema = require('./lib/settings');
const { Users, Sessions, Throttle, verifyPassword, getDummyHash, verifyTotp } = require('./lib/auth');

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
const updates = new Updates({ jobs, backups, countdown, mcDir: config.mcDir, mcJar: config.mcJar, log });
const gameVersion = async () => (await updates.installed())?.version || null;
const plugins = new Plugins({ mcDir: config.mcDir, jobs, pending, log, gameVersion });
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
  power: await power.state(),
  maintenance: { enabled: maintenance.state().enabled, since: maintenance.state().since ?? null },
  restart: { remaining: countdown.remaining, verb: countdown.verb },
  backup: backups.state,
  update: updates.state,
  op: ops.state,
  pending: await pending.list(),
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

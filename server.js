#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Rcon } = require('./lib/rcon');
const { LogTail } = require('./lib/logtail');
const { Stats } = require('./lib/stats');
const { readAccess } = require('./lib/access');
const { Backups } = require('./lib/backups');
const { Scheduler, Countdown } = require('./lib/scheduler');

const env = process.env;
const config = {
  rconHost: env.RCON_HOST || '127.0.0.1',
  rconPort: Number(env.RCON_PORT) || 25575,
  rconPassword: env.RCON_PASSWORD,
  webHost: env.WEB_HOST || '127.0.0.1',
  webPort: Number(env.WEB_PORT) || 8080,
  webUser: env.WEB_USER || 'admin',
  webPassword: env.WEB_PASSWORD,
  mcDir: path.resolve(env.MC_DIR || '/srv/minecraft'),
  backupDir: path.resolve(env.BACKUP_DIR || '/srv/minecraft-backups'),
  backupKeep: env.BACKUP_KEEP === undefined ? 10 : Number(env.BACKUP_KEEP),
  // systemd sets STATE_DIRECTORY when the unit has StateDirectory=
  stateDir: path.resolve(env.STATE_DIRECTORY || env.STATE_DIR || path.join(__dirname, 'data')),
};

for (const key of ['RCON_PASSWORD', 'WEB_PASSWORD']) {
  if (!env[key]) {
    console.error(`Missing required environment variable ${key}`);
    process.exit(1);
  }
}

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const rcon = new Rcon({ host: config.rconHost, port: config.rconPort, password: config.rconPassword });
const logTail = new LogTail(path.join(config.mcDir, 'logs', 'latest.log'));
const stats = new Stats({ rcon, mcDir: config.mcDir });
const backups = new Backups({ rcon, mcDir: config.mcDir, backupDir: config.backupDir, keep: config.backupKeep, log });
const countdown = new Countdown({ rcon, log });
const scheduler = new Scheduler({ rcon, backups, countdown, stateDir: config.stateDir, log });

// ---------------------------------------------------------------------------
// Static files (loaded once, served from memory)
// ---------------------------------------------------------------------------

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
for (const entry of Object.values(STATIC)) {
  entry[0] = fs.readFileSync(path.join(__dirname, 'public', entry[0]));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' https://mc-heads.net; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function authorized(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  const userOk = safeEqual(decoded.slice(0, sep), config.webUser);
  const passOk = safeEqual(decoded.slice(sep + 1), config.webPassword);
  return userOk && passOk;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
  res.end(payload);
}

function readJson(req, limit = 16 * 1024) {
  // Requiring JSON means a cross-site form post can't reach the API.
  if (!String(req.headers['content-type']).startsWith('application/json')) {
    return Promise.reject(Object.assign(new Error('Content-Type must be application/json'), { status: 415 }));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
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
  logTail.on('line', onLine);
  const ping = setInterval(() => {
    res.write(': ping\n\n');
    if (logTail.error) event('status', { error: logTail.error });
  }, 15000);
  req.on('close', () => {
    clearInterval(ping);
    logTail.off('line', onLine);
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('POST', /^\/api\/command$/, async (req) => {
  const { command } = await readJson(req);
  const cmd = String(command || '').trim().replace(/^\//, '');
  if (!cmd) throw Object.assign(new Error('Missing command'), { status: 400 });
  if (cmd.length > 1400) throw Object.assign(new Error('Command too long'), { status: 400 });
  log(`command: ${cmd}`);
  return { output: await rcon.send(cmd) };
});

route('GET', /^\/api\/status$/, async () => ({
  ...(await stats.get()),
  restart: { remaining: countdown.remaining },
  backup: backups.state,
}));

route('GET', /^\/api\/access$/, () => readAccess(config.mcDir));

route('GET', /^\/api\/backups$/, async () => ({ dir: config.backupDir, keep: config.backupKeep, files: await backups.list(), state: backups.state }));

route('POST', /^\/api\/backups$/, async (req, res) => {
  backups.run().catch(() => {}); // progress is reported through state
  return [202, { state: backups.state }];
});

route('GET', /^\/api\/backups\/([^/]+)$/, async (req, res, [name]) => {
  const file = backups.filePath(decodeURIComponent(name));
  const stat = await fs.promises.stat(file);
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
  log(`backup: deleted ${name}`);
  return { ok: true };
});

route('POST', /^\/api\/restart$/, async (req) => {
  const { seconds } = await readJson(req);
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0 || s > 3600) throw Object.assign(new Error('seconds must be 0-3600'), { status: 400 });
  countdown.start(s, 'manual').catch(() => {});
  return { remaining: countdown.remaining };
});

route('DELETE', /^\/api\/restart$/, async () => ({ cancelled: countdown.cancel() }));

route('GET', /^\/api\/tasks$/, async () => ({ tasks: scheduler.list() }));
route('POST', /^\/api\/tasks$/, async (req) => [201, await scheduler.create(await readJson(req))]);
route('PATCH', /^\/api\/tasks\/([\w-]+)$/, async (req, res, [id]) => scheduler.update(id, await readJson(req)));
route('DELETE', /^\/api\/tasks\/([\w-]+)$/, async (req, res, [id]) => {
  await scheduler.remove(id);
  return { ok: true };
});
route('POST', /^\/api\/tasks\/([\w-]+)\/run$/, async (req, res, [id]) => {
  scheduler.get(id);
  scheduler.run(id).catch(() => {}); // restarts and backups can take minutes
  return [202, { ok: true }];
});

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="rconsole", charset="UTF-8"');
    return send(res, 401, { error: 'Unauthorized' });
  }

  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && STATIC[pathname]) {
    const [body, type] = STATIC[pathname];
    return send(res, 200, body, type);
  }
  if (req.method === 'GET' && pathname === '/api/logs') return streamLogs(req, res);

  for (const { method, pattern, handler } of routes) {
    const match = pathname.match(pattern);
    if (!match || method !== req.method) continue;
    try {
      const result = await handler(req, res, match.slice(1));
      if (result === null) return; // handler wrote the response itself
      const [status, body] = Array.isArray(result) ? result : [200, result];
      return send(res, status, body);
    } catch (err) {
      const status = err.status || (err.code === 'ENOENT' ? 404 : 502);
      if (!res.headersSent) send(res, status, { error: err.message });
      else res.destroy();
      return;
    }
  }

  send(res, 404, { error: 'Not found' });
});

scheduler.load().then(() => {
  logTail.start();
  server.listen(config.webPort, config.webHost, () => {
    log(`rconsole listening on http://${config.webHost}:${config.webPort}`);
    log(`RCON ${config.rconHost}:${config.rconPort}, server dir ${config.mcDir}, backups ${config.backupDir}`);
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

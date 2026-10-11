#!/usr/bin/env node
'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');

const config = {
  rconHost: process.env.RCON_HOST || '127.0.0.1',
  rconPort: Number(process.env.RCON_PORT) || 25575,
  rconPassword: process.env.RCON_PASSWORD,
  webHost: process.env.WEB_HOST || '127.0.0.1',
  webPort: Number(process.env.WEB_PORT) || 8080,
  webUser: process.env.WEB_USER || 'admin',
  webPassword: process.env.WEB_PASSWORD,
};

for (const key of ['RCON_PASSWORD', 'WEB_PASSWORD']) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable ${key}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// RCON client (Source RCON protocol, as implemented by Minecraft)
// ---------------------------------------------------------------------------

const TYPE_AUTH = 3;
const TYPE_COMMAND = 2;
const MAX_FRAGMENT = 4096; // Minecraft splits responses into 4096-byte bodies
const TIMEOUT_MS = 5000;

function encodePacket(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf; // trailing two bytes are already 0x00
}

class Rcon {
  constructor({ host, port, password }) {
    Object.assign(this, { host, port, password });
    this.socket = null;
    this.connecting = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = null; // { id, chunks, resolve, reject, timer, idle }
    this.queue = Promise.resolve();
  }

  connect() {
    if (this.socket) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30000);

      const fail = (err) => {
        this.reset(err);
        reject(err);
      };

      socket.once('error', fail);
      socket.on('data', (data) => this.onData(data));
      socket.on('close', () => this.reset(new Error('RCON connection closed')));

      socket.once('connect', () => {
        this.socket = socket;
        socket.off('error', fail);
        socket.on('error', (err) => this.reset(err));
        this.request(TYPE_AUTH, this.password)
          .then(() => resolve())
          .catch((err) => {
            socket.destroy();
            reject(err);
          });
      });
    }).finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  reset(err) {
    if (this.socket) this.socket.destroy();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    if (this.pending) {
      const { reject, timer, idle } = this.pending;
      clearTimeout(timer);
      clearTimeout(idle);
      this.pending = null;
      reject(err);
    }
  }

  onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0);
      if (this.buffer.length < length + 4) break;
      const id = this.buffer.readInt32LE(4);
      const type = this.buffer.readInt32LE(8);
      const body = this.buffer.subarray(12, length + 2).toString('utf8');
      this.buffer = this.buffer.subarray(length + 4);
      this.onPacket(id, type, body);
    }
  }

  onPacket(id, type, body) {
    const p = this.pending;
    if (!p) return;

    if (p.type === TYPE_AUTH) {
      if (type !== 2) return; // ignore the empty RESPONSE_VALUE some servers send first
      clearTimeout(p.timer);
      this.pending = null;
      if (id === -1) p.reject(new Error('RCON authentication failed (check RCON_PASSWORD)'));
      else p.resolve('');
      return;
    }

    if (id !== p.id) return;
    p.chunks.push(body);
    clearTimeout(p.idle);
    const finish = () => {
      clearTimeout(p.timer);
      this.pending = null;
      p.resolve(p.chunks.join(''));
    };
    // A full-size fragment means more may follow; wait briefly for it.
    if (Buffer.byteLength(body) < MAX_FRAGMENT) finish();
    else p.idle = setTimeout(finish, 150);
  }

  request(type, body) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      if (this.nextId > 0x7fffffff) this.nextId = 1;
      const timer = setTimeout(() => this.reset(new Error('RCON request timed out')), TIMEOUT_MS);
      this.pending = { id, type, chunks: [], resolve, reject, timer, idle: null };
      this.socket.write(encodePacket(id, type, body));
    });
  }

  // Commands are serialized so each response maps to exactly one request.
  send(command) {
    const run = () => this.connect().then(() => this.request(TYPE_COMMAND, command));
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }
}

const rcon = new Rcon({
  host: config.rconHost,
  port: config.rconPort,
  password: config.rconPassword,
});

const stripColors = (s) => s.replace(/§[0-9a-fk-or]/gi, '');

function parsePlayers(output) {
  // "There are 2 of a max of 20 players online: Alex, Steve"
  const m = output.match(/There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)/i);
  if (!m) return { online: 0, max: 0, players: [] };
  const players = m[3].split(',').map((s) => s.trim()).filter(Boolean);
  return { online: Number(m[1]), max: Number(m[2]), players };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

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
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(payload);
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="rconsole", charset="UTF-8"');
    return send(res, 401, { error: 'Unauthorized' });
  }

  const url = new URL(req.url, 'http://localhost');

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, PAGE, 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && url.pathname === '/api/players') {
      const output = stripColors(await rcon.send('list'));
      return send(res, 200, parsePlayers(output));
    }

    if (req.method === 'POST' && url.pathname === '/api/command') {
      // Require JSON so a cross-site form post can't trigger commands.
      if (!String(req.headers['content-type']).startsWith('application/json')) {
        return send(res, 415, { error: 'Content-Type must be application/json' });
      }
      const { command } = await readJson(req);
      const cmd = String(command || '').trim().replace(/^\//, '');
      if (!cmd) return send(res, 400, { error: 'Missing command' });
      if (cmd.length > 1400) return send(res, 400, { error: 'Command too long' });
      console.log(`[${new Date().toISOString()}] ${cmd}`);
      const output = stripColors(await rcon.send(cmd));
      return send(res, 200, { output });
    }

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    send(res, 502, { error: err.message });
  }
});

server.listen(config.webPort, config.webHost, () => {
  console.log(`rconsole listening on http://${config.webHost}:${config.webPort}`);
  console.log(`RCON target ${config.rconHost}:${config.rconPort}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    rcon.reset(new Error('Shutting down'));
    server.close(() => process.exit(0));
  });
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>rconsole</title>
<style>
  :root {
    --bg: #0d0f12; --panel: #15181d; --line: #242931; --text: #e6e8eb;
    --muted: #8a919c; --accent: #5ee28a; --danger: #ff6b6b;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px 16px; display: grid; gap: 16px;
          grid-template-columns: 1fr 280px; grid-template-areas: "head head" "main side"; }
  @media (max-width: 800px) {
    .wrap { grid-template-columns: 1fr; grid-template-areas: "head" "side" "main"; }
  }
  header { grid-area: head; display: flex; align-items: center; gap: 10px; }
  header h1 { font-size: 18px; margin: 0; letter-spacing: .02em; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
  .dot.on { background: var(--accent); box-shadow: 0 0 8px var(--accent); }
  .dot.off { background: var(--danger); }
  #status { color: var(--muted); font-size: 13px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
  main { grid-area: main; display: flex; flex-direction: column; min-height: 70vh; }
  #log { flex: 1; overflow-y: auto; padding: 14px; font: 13px/1.55 var(--mono);
         white-space: pre-wrap; word-break: break-word; max-height: 70vh; }
  .entry { margin-bottom: 10px; }
  .cmd { color: var(--accent); }
  .err { color: var(--danger); }
  .time { color: var(--muted); margin-right: 8px; }
  form.console { display: flex; border-top: 1px solid var(--line); }
  form.console span { padding: 12px 0 12px 14px; color: var(--accent); font-family: var(--mono); }
  input { background: transparent; border: 0; color: var(--text); font: 14px var(--mono);
          padding: 12px; outline: none; width: 100%; }
  aside { grid-area: side; display: flex; flex-direction: column; gap: 16px; }
  aside .panel { padding: 14px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted);
       margin: 0 0 10px; font-weight: 600; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  button { background: #1c2027; color: var(--text); border: 1px solid var(--line);
           border-radius: 6px; padding: 7px 8px; font: inherit; font-size: 13px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.danger:hover { border-color: var(--danger); color: var(--danger); }
  .field { background: #0f1115; border: 1px solid var(--line); border-radius: 6px;
           font-family: inherit; padding: 7px 9px; margin-bottom: 8px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 8px; padding: 5px 0; cursor: pointer; }
  li img { width: 20px; height: 20px; border-radius: 3px; image-rendering: pixelated; }
  li:hover { color: var(--accent); }
  .empty { color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <header><span class="dot" id="dot"></span><h1>rconsole</h1><span id="status">connecting…</span></header>

  <main class="panel">
    <div id="log"></div>
    <form class="console" id="form">
      <span>/</span>
      <input id="cmd" autocomplete="off" spellcheck="false" placeholder="type a command, e.g. say hello" autofocus>
    </form>
  </main>

  <aside>
    <section class="panel">
      <h2>Players <span id="count"></span></h2>
      <ul id="players"><li class="empty">—</li></ul>
    </section>

    <section class="panel">
      <h2>Player actions</h2>
      <input class="field" id="player" placeholder="player name" autocomplete="off">
      <div class="grid">
        <button data-p="whitelist add {p}">Whitelist +</button>
        <button data-p="whitelist remove {p}">Whitelist −</button>
        <button data-p="op {p}">Op</button>
        <button data-p="deop {p}">Deop</button>
        <button data-p="gamemode creative {p}">Creative</button>
        <button data-p="gamemode survival {p}">Survival</button>
        <button class="danger" data-p="kick {p}">Kick</button>
        <button class="danger" data-p="ban {p}" data-confirm>Ban</button>
      </div>
    </section>

    <section class="panel">
      <h2>Server</h2>
      <div class="grid">
        <button data-c="save-all">Save all</button>
        <button data-c="whitelist list">Whitelist</button>
        <button data-c="time set day">Day</button>
        <button data-c="time set night">Night</button>
        <button data-c="weather clear">Clear sky</button>
        <button data-c="weather rain">Rain</button>
        <button data-c="difficulty">Difficulty</button>
        <button class="danger" data-c="stop" data-confirm>Stop server</button>
      </div>
    </section>
  </aside>
</div>

<script>
  const $ = (id) => document.getElementById(id);
  const log = $('log');
  const history = [];
  let histPos = 0;

  function line(cls, text) {
    const div = document.createElement('div');
    div.className = 'entry ' + cls;
    const t = document.createElement('span');
    t.className = 'time';
    t.textContent = new Date().toLocaleTimeString();
    div.append(t, document.createTextNode(text));
    log.append(div);
    log.scrollTop = log.scrollHeight;
  }

  async function run(command) {
    line('cmd', '/' + command);
    try {
      const res = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      line('', data.output || '(no output)');
    } catch (e) {
      line('err', e.message);
    }
    refreshPlayers();
  }

  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const cmd = $('cmd').value.trim();
    if (!cmd) return;
    history.push(cmd);
    histPos = history.length;
    $('cmd').value = '';
    run(cmd.replace(/^\\//, ''));
  });

  $('cmd').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && histPos > 0) $('cmd').value = history[--histPos];
    else if (e.key === 'ArrowDown') {
      histPos = Math.min(history.length, histPos + 1);
      $('cmd').value = history[histPos] || '';
    } else return;
    e.preventDefault();
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    let cmd = b.dataset.c;
    if (b.dataset.p) {
      const p = $('player').value.trim();
      if (!/^[A-Za-z0-9_]{1,16}$/.test(p)) return line('err', 'Enter a valid player name first');
      cmd = b.dataset.p.replace('{p}', p);
    }
    if (b.hasAttribute('data-confirm') && !confirm('Run "/' + cmd + '"?')) return;
    run(cmd);
  });

  async function refreshPlayers() {
    try {
      const res = await fetch('/api/players');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      $('dot').className = 'dot on';
      $('status').textContent = 'connected';
      $('count').textContent = '(' + data.online + '/' + data.max + ')';
      const ul = $('players');
      ul.replaceChildren();
      if (!data.players.length) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'nobody online';
        ul.append(li);
      }
      for (const name of data.players) {
        const li = document.createElement('li');
        const img = document.createElement('img');
        img.src = 'https://mc-heads.net/avatar/' + encodeURIComponent(name) + '/20';
        img.alt = '';
        li.append(img, document.createTextNode(name));
        li.onclick = () => { $('player').value = name; };
        ul.append(li);
      }
    } catch (e) {
      $('dot').className = 'dot off';
      $('status').textContent = e.message;
    }
  }

  refreshPlayers();
  setInterval(refreshPlayers, 10000);
</script>
</body>
</html>`;

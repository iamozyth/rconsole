'use strict';

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    location.replace('/login');
    throw new Error('Signed out');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const fmt = {
  bytes(n) {
    if (n == null) return '–';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  },
  duration(s) {
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  },
  countdown(s) {
    return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
  },
  date(iso) {
    return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–';
  },
  gameTime(t) {
    const h = (Math.floor(t / 1000) + 6) % 24;
    const m = Math.floor(((t % 1000) * 60) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  },
  pct: (x) => `${Math.round(x * 100)}%`,
};

function avatar(id) {
  const img = el('img', { src: `https://mc-heads.net/avatar/${encodeURIComponent(id)}/20`, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => (img.style.visibility = 'hidden'));
  return img;
}
const empty = (text) => el('li', { class: 'empty' }, text);
const level = (ratio, warn, bad) => (ratio >= bad ? 'bad' : ratio >= warn ? 'meh' : 'good');
const PLAYER_RE = /^[A-Za-z0-9_]{1,16}$/;

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const tabLoaders = {};

function showTab(name) {
  if (!$(`tab-${name}`)) name = 'console';
  for (const b of document.querySelectorAll('[role=tab]')) b.setAttribute('aria-selected', b.dataset.tab === name);
  for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== `tab-${name}`;
  history.replaceState(null, '', `#${name}`);
  tabLoaders[name]?.();
  if (name === 'console') scrollLog(true);
}

window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[role=tab]');
  if (b) showTab(b.dataset.tab);
});

// ---------------------------------------------------------------------------
// Console: live log + command prompt
// ---------------------------------------------------------------------------

const log = $('log');
const MAX_LINES = 3000;
const history_ = [];
let histPos = 0;

function classify(line) {
  if (/\/(ERROR|FATAL)\]/.test(line)) return 'error';
  if (/\/WARN\]/.test(line)) return 'warn';
  if (/\]: (\[Not Secure\] )?<[^>]+> /.test(line) || /\]: \[(Server|Rcon)\] /.test(line)) return 'chat';
  if (/ joined the game$/.test(line)) return 'join';
  if (/ left the game$/.test(line)) return 'leave';
  return '';
}

function visible(div) {
  const q = $('filter').value.trim().toLowerCase();
  const chatOnly = $('chat-only').checked;
  if (chatOnly && !/\b(chat|join|leave|cmd|reply)\b/.test(div.className)) return false;
  return !q || div.textContent.toLowerCase().includes(q);
}

function scrollLog(force) {
  if (force || $('follow').checked) log.scrollTop = log.scrollHeight;
}

function addLine(text, cls = classify(text)) {
  const div = el('div', { class: cls }, text);
  div.hidden = !visible(div);
  log.append(div);
  while (log.childElementCount > MAX_LINES) log.firstElementChild.remove();
  scrollLog();
}

function refilter() {
  for (const div of log.children) div.hidden = !visible(div);
  scrollLog(true);
}
$('filter').addEventListener('input', refilter);
$('chat-only').addEventListener('change', refilter);
$('clear-log').addEventListener('click', () => log.replaceChildren());
log.addEventListener('scroll', () => {
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  if ($('follow').checked !== atBottom) $('follow').checked = atBottom;
});

function setLogStatus(error) {
  $('log-status').hidden = !error;
  $('log-status').textContent = error ? `Server log unavailable: ${error}` : '';
}

function connectLogs() {
  const source = new EventSource('/api/logs');
  source.addEventListener('backlog', (e) => {
    const { lines, error } = JSON.parse(e.data);
    log.replaceChildren();
    setLogStatus(error);
    lines.forEach((l) => addLine(l));
  });
  source.addEventListener('line', (e) => addLine(JSON.parse(e.data)));
  source.addEventListener('status', (e) => setLogStatus(JSON.parse(e.data).error));
  // EventSource retries on its own; check whether we were signed out.
  source.addEventListener('error', () => api('GET', '/api/me').catch(() => {}));
}

async function run(command) {
  addLine(`> /${command}`, 'cmd');
  try {
    const { output } = await api('POST', '/api/command', { command });
    addLine(output || '(no output)', 'reply');
  } catch (e) {
    addLine(e.message, 'reply error');
  }
  scrollLog(true);
  refreshStatus(true);
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const cmd = $('cmd').value.trim();
  if (!cmd) return;
  history_.push(cmd);
  histPos = history_.length;
  $('cmd').value = '';
  $('follow').checked = true;
  run(cmd.replace(/^\//, ''));
});

$('cmd').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' && histPos > 0) $('cmd').value = history_[--histPos];
  else if (e.key === 'ArrowDown') {
    histPos = Math.min(history_.length, histPos + 1);
    $('cmd').value = history_[histPos] || '';
  } else return;
  e.preventDefault();
});

document.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => run(b.dataset.c)));

// ---------------------------------------------------------------------------
// Status bar, online players, restart countdown
// ---------------------------------------------------------------------------

let lastStatus = null;
let countdownEnd = null;

function setStat(id, text, cls = '') {
  $(id).textContent = text;
  $(id).className = cls;
}

function renderStatus(s) {
  lastStatus = s;
  const { game, host, rcon } = s;
  $('dot').className = `dot ${rcon.ok ? 'on' : 'off'}`;
  $('status').textContent = rcon.ok ? 'connected' : rcon.error;

  if (game?.tps != null) {
    const tps = game.tps;
    setStat('s-tps', tps.toFixed(1) + (game.mspt != null ? ` · ${game.mspt.toFixed(1)}ms` : ''), tps >= 19 ? 'good' : tps >= 15 ? 'meh' : 'bad');
  } else setStat('s-tps', game ? 'n/a' : '–');
  setStat('s-players', game?.players ? `${game.players.online}/${game.players.max}` : '–');
  setStat('s-time', game?.daytime != null ? `D${game.day ?? '?'} ${fmt.gameTime(game.daytime)}` : '–');
  setStat('s-cpu', host.cpu != null ? fmt.pct(host.cpu) : '–', host.cpu != null ? level(host.cpu, 0.7, 0.9) : '');
  const memUsed = 1 - host.mem.available / host.mem.total;
  setStat('s-mem', `${fmt.bytes(host.mem.total - host.mem.available)} / ${fmt.bytes(host.mem.total)}`, level(memUsed, 0.8, 0.92));
  if (host.disk) {
    const used = 1 - host.disk.available / host.disk.total;
    setStat('s-disk', `${fmt.bytes(host.disk.available)} free`, level(used, 0.8, 0.92));
  }
  setStat('s-uptime', fmt.duration(host.uptime));

  const players = game?.players?.players || [];
  $('count').textContent = game?.players ? `(${game.players.online}/${game.players.max})` : '';
  $('online').replaceChildren(
    ...(players.length
      ? players.map((name) =>
          el('li', { title: 'Click to insert name', onclick: () => insertName(name) }, avatar(name), el('span', { class: 'name' }, name))
        )
      : [empty(rcon.ok ? 'nobody online' : '—')])
  );

  const remaining = s.restart?.remaining;
  countdownEnd = remaining != null ? Date.now() + remaining * 1000 : null;
  tickCountdown();

  renderBackupState(s.backup);
}

function insertName(name) {
  const input = $('cmd');
  input.value = input.value ? `${input.value.replace(/\s*$/, ' ')}${name}` : name;
  input.focus();
}

function tickCountdown() {
  const left = countdownEnd ? Math.max(0, Math.round((countdownEnd - Date.now()) / 1000)) : null;
  $('restart-banner').hidden = left == null;
  if (left != null) $('restart-left').textContent = fmt.countdown(left);
}
setInterval(tickCountdown, 1000);

let statusTimer;
async function refreshStatus(soon) {
  clearTimeout(statusTimer);
  if (soon) await new Promise((r) => setTimeout(r, 300));
  try {
    renderStatus(await api('GET', '/api/status'));
  } catch (e) {
    $('dot').className = 'dot off';
    $('status').textContent = e.message;
  }
  statusTimer = setTimeout(refreshStatus, 5000);
}

$('restart-start').addEventListener('click', async () => {
  const seconds = Number($('restart-delay').value);
  if (!confirm(`Restart the server in ${fmt.countdown(seconds)}? Players will be warned in chat.`)) return;
  try {
    await api('POST', '/api/restart', { seconds });
    addLine(`Restart scheduled in ${fmt.countdown(seconds)}`, 'sys');
  } catch (e) {
    alert(e.message);
  }
  refreshStatus();
});

$('restart-cancel').addEventListener('click', async () => {
  await api('DELETE', '/api/restart').catch((e) => alert(e.message));
  refreshStatus();
});

// ---------------------------------------------------------------------------
// Players: whitelist, ops, bans
// ---------------------------------------------------------------------------

async function loadAccess() {
  try {
    const a = await api('GET', '/api/access');
    $('access-error').textContent = '';
    $('wl-toggle').checked = a.whitelistEnabled;
    $('wl-state').textContent = a.whitelistEnabled ? 'on' : 'off';

    const personRow = (p, meta, removeCmd, label) =>
      el('li', {},
        avatar(p.uuid || p.name),
        el('span', { class: 'name' }, p.name, meta ? el('div', { class: 'meta' }, meta) : null),
        el('button', { class: 'link', title: label, onclick: () => mutate(removeCmd) }, label));

    const banMeta = (b) => [b.reason, b.source && `by ${b.source}`, b.expires && b.expires !== 'forever' && `until ${b.expires}`].filter(Boolean).join(' · ');

    $('list-whitelist').replaceChildren(...(a.whitelist.length ? a.whitelist.map((p) => personRow(p, null, `whitelist remove ${p.name}`, 'Remove')) : [empty('empty')]));
    $('list-ops').replaceChildren(...(a.ops.length ? a.ops.map((p) => personRow(p, `level ${p.level}`, `deop ${p.name}`, 'Deop')) : [empty('none')]));
    $('list-bans').replaceChildren(...(a.bans.length ? a.bans.map((b) => personRow(b, banMeta(b), `pardon ${b.name}`, 'Unban')) : [empty('none')]));
    $('list-ipbans').replaceChildren(
      ...(a.ipBans.length
        ? a.ipBans.map((b) =>
            el('li', {},
              el('span', { class: 'name mono' }, b.ip, el('div', { class: 'meta' }, banMeta(b))),
              el('button', { class: 'link', onclick: () => mutate(`pardon-ip ${b.ip}`) }, 'Unban')))
        : [empty('none')])
    );
  } catch (e) {
    $('access-error').textContent = e.message;
  }
}
tabLoaders.players = loadAccess;

async function mutate(command) {
  try {
    const { output } = await api('POST', '/api/command', { command });
    addLine(`> /${command}`, 'cmd');
    addLine(output || '(no output)', 'reply');
  } catch (e) {
    alert(e.message);
  }
  setTimeout(loadAccess, 400); // give the server a moment to write its JSON files
}

$('wl-toggle').addEventListener('change', (e) => mutate(`whitelist ${e.target.checked ? 'on' : 'off'}`));

document.querySelectorAll('form.add').forEach((form) => {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = form.querySelector('input:not([data-reason])');
    const reason = form.querySelector('[data-reason]')?.value.trim();
    const value = input.value.trim();
    const ok = form.dataset.kind === 'player' ? PLAYER_RE.test(value) : /^[\w.:]+$/.test(value);
    if (!ok) return alert(`"${value}" is not a valid ${form.dataset.kind === 'player' ? 'player name' : 'IP or player name'}`);
    const command = form.dataset.cmd.replace('{v}', value) + (reason ? ` ${reason}` : '');
    if (form.hasAttribute('data-confirm') && !confirm(`Run "/${command}"?`)) return;
    form.reset();
    mutate(command);
  });
});

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

let backupWasRunning = false;

function renderBackupState(state) {
  if (!state) return;
  $('backup-now').disabled = state.running;
  $('backup-now').textContent = state.running ? 'Backing up…' : 'Back up now';
  $('backup-state').textContent = state.running
    ? `Backup in progress since ${fmt.date(state.startedAt)}…`
    : state.lastError
      ? `Last backup failed: ${state.lastError}`
      : '';
  $('backup-state').className = state.lastError && !state.running ? 'hint bad' : 'hint';
  if (backupWasRunning && !state.running) loadBackups();
  backupWasRunning = state.running;
}

async function loadBackups() {
  try {
    const { dir, keep, files, state } = await api('GET', '/api/backups');
    $('backup-info').textContent = `Stored in ${dir}${keep ? `, keeping the newest ${keep}` : ''}.`;
    renderBackupState(state);
    $('backup-list').replaceChildren(
      ...(files.length
        ? files.map((f) =>
            el('tr', {},
              el('td', { class: 'mono' }, f.name),
              el('td', {}, fmt.bytes(f.size)),
              el('td', {}, fmt.date(f.created)),
              el('td', {},
                el('a', { href: `/api/backups/${encodeURIComponent(f.name)}`, download: f.name }, 'Download'),
                el('button', { class: 'link', onclick: () => deleteBackup(f.name) }, 'Delete'))))
        : [el('tr', {}, el('td', { class: 'empty', colspan: 4 }, 'No backups yet'))])
    );
  } catch (e) {
    $('backup-state').textContent = e.message;
  }
}
tabLoaders.backups = loadBackups;

async function deleteBackup(name) {
  if (!confirm(`Delete ${name}?`)) return;
  await api('DELETE', `/api/backups/${encodeURIComponent(name)}`).catch((e) => alert(e.message));
  loadBackups();
}

$('backup-now').addEventListener('click', async () => {
  try {
    renderBackupState((await api('POST', '/api/backups')).state);
  } catch (e) {
    alert(e.message);
  }
});

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TYPE_LABEL = { restart: 'Restart', backup: 'Backup', command: 'Command' };

function describeDays(days) {
  if (!days.length || days.length === 7) return 'daily';
  if (days.join() === '1,2,3,4,5') return 'weekdays';
  if (days.join() === '0,6') return 'weekends';
  return days.map((d) => DAY_NAMES[d]).join(', ');
}

async function loadTasks() {
  try {
    const { tasks } = await api('GET', '/api/tasks');
    $('task-list').replaceChildren(
      ...(tasks.length
        ? tasks.map((t) => {
            const detail = t.type === 'command' ? `/${t.command}` : t.type === 'restart' ? `${t.warnMinutes} min warning` : '';
            return el('tr', {},
              el('td', {},
                el('div', {}, el('b', {}, t.name || TYPE_LABEL[t.type]), ' ', el('span', { class: `pill ${t.enabled ? 'on' : ''}` }, t.enabled ? TYPE_LABEL[t.type] : 'paused')),
                detail && el('div', { class: 'hint mono' }, detail)),
              el('td', {}, `${t.time} ${describeDays(t.days)}`),
              el('td', {}, t.enabled ? fmt.date(t.nextRun) : '–'),
              el('td', { class: 'hint' }, t.lastRun ? `${fmt.date(t.lastRun)}: ${t.lastResult}` : 'never'),
              el('td', {},
                el('button', { class: 'link', onclick: () => taskAction('PATCH', t, { enabled: !t.enabled }) }, t.enabled ? 'Pause' : 'Resume'),
                el('button', { class: 'link', onclick: () => runTask(t) }, 'Run now'),
                el('button', { class: 'link', onclick: () => confirm('Delete this task?') && taskAction('DELETE', t) }, 'Delete')));
          })
        : [el('tr', {}, el('td', { class: 'empty', colspan: 5 }, 'No scheduled tasks'))])
    );
  } catch (e) {
    $('task-error').textContent = e.message;
  }
}
tabLoaders.schedule = loadTasks;

async function taskAction(method, task, body) {
  await api(method, `/api/tasks/${task.id}`, body).catch((e) => alert(e.message));
  loadTasks();
}

async function runTask(task) {
  const what = task.type === 'restart' ? `restart the server (${task.warnMinutes} min countdown)` : `run "${task.name || TYPE_LABEL[task.type]}"`;
  if (!confirm(`Run now: ${what}?`)) return;
  await api('POST', `/api/tasks/${task.id}/run`).catch((e) => alert(e.message));
  setTimeout(loadTasks, 1000);
  refreshStatus(true);
}

const taskForm = $('task-form');
function syncTaskForm() {
  const type = taskForm.elements.type.value;
  taskForm.querySelectorAll('[data-for]').forEach((l) => (l.hidden = l.dataset.for !== type));
}
taskForm.elements.type.addEventListener('change', syncTaskForm);

taskForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = taskForm.elements;
  const body = {
    type: f.type.value,
    time: f.time.value,
    name: f.name.value,
    days: [...taskForm.querySelectorAll('.days input:checked')].map((i) => Number(i.value)),
    warnMinutes: Number(f.warnMinutes.value),
    command: f.command.value,
  };
  try {
    await api('POST', '/api/tasks', body);
    $('task-error').textContent = '';
    f.name.value = '';
    f.command.value = '';
    loadTasks();
  } catch (err) {
    $('task-error').textContent = err.message;
  }
});

// ---------------------------------------------------------------------------

$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.replace('/login');
});
api('GET', '/api/me').then(({ user }) => ($('me').textContent = user)).catch(() => {});

connectLogs();
refreshStatus();
showTab(location.hash.slice(1));
syncTaskForm();

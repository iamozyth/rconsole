'use strict';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false && c !== ''));
  return node;
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#pg-${name}`);
  svg.append(use);
  return svg;
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
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
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
  delay(s) {
    return s >= 60 ? `${s / 60} minute${s === 60 ? '' : 's'}` : `${s} seconds`;
  },
  date(iso) {
    return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–';
  },
  relative(iso) {
    if (!iso) return '';
    const diff = (new Date(iso) - Date.now()) / 1000;
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    const abs = Math.abs(diff);
    if (abs < 60) return rtf.format(Math.round(diff), 'second');
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    return rtf.format(Math.round(diff / 86400), 'day');
  },
  gameTime(t) {
    const h = (Math.floor(t / 1000) + 6) % 24;
    const m = Math.floor(((t % 1000) * 60) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  },
  pct: (x) => `${Math.round(x * 100)}%`,
};

const PLAYER_RE = /^[A-Za-z0-9_]{1,16}$/;
const level = (ratio, warn, bad) => (ratio >= bad ? 'bad' : ratio >= warn ? 'meh' : 'good');

function avatar(id) {
  const img = el('img', { class: 'avatar', src: `https://mc-heads.net/avatar/${encodeURIComponent(id)}/24`, alt: '', loading: 'lazy', width: 24, height: 24 });
  img.addEventListener('error', () => img.replaceWith(el('span', { class: 'ip-tile' }, icon('players'))));
  return img;
}

// ---------------------------------------------------------------------------
// Feedback: confirm dialog, toasts, busy buttons
// ---------------------------------------------------------------------------

const TONES = { danger: 'var(--c-danger)', primary: null };
const BTN_CLASS = { danger: 'btn btn-danger', primary: 'btn btn-primary' };

function confirmAction({ title, body = '', confirm = 'Confirm', tone = 'primary', icon: iconName = 'alert', content = null }) {
  const dlg = $('dialog');
  $('dialog-title').textContent = title;
  $('dialog-body').textContent = body;
  $('dialog-body').hidden = !body;
  $('dialog-fields').replaceChildren(...(content ? [content] : []));
  $('dialog-fields').hidden = !content;
  $('dialog-icon').setAttribute('href', `#pg-${iconName}`);
  $('dialog-tile').style.setProperty('--dlg', TONES[tone] || 'var(--area)');
  const ok = $('dialog-confirm');
  ok.className = BTN_CLASS[tone] || BTN_CLASS.primary;
  ok.textContent = confirm;
  dlg.returnValue = '';
  dlg.showModal();
  ok.focus();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'confirm'), { once: true }));
}

function toast(message, kind = 'ok') {
  const node = el('div', { class: `toast ${kind}`, role: kind === 'bad' ? 'alert' : 'status' },
    icon(kind === 'bad' ? 'alert' : 'check'), el('span', {}, message));
  $('toasts').append(node);
  const ttl = kind === 'bad' ? 8000 : 4000;
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 220);
  }, ttl);
}

async function busy(button, fn) {
  if (button.getAttribute('aria-busy') === 'true') return;
  button.setAttribute('aria-busy', 'true');
  try {
    return await fn();
  } finally {
    button.removeAttribute('aria-busy');
  }
}

function skeletonRows(tbody, cols) {
  tbody.replaceChildren(
    ...[80, 60, 40].map((w) => el('tr', {}, ...Array.from({ length: cols }, (_, i) => el('td', {}, el('span', { class: `skeleton w${i === 0 ? w : 40}` })))))
  );
}

function skeletonList(ul) {
  ul.replaceChildren(...[60, 40].map((w) => el('li', {}, el('span', { class: `skeleton w${w}` }))));
}

const emptyRow = (cols, ...content) => el('tr', {}, el('td', { class: 'empty-state', colspan: cols }, ...content));
const emptyItem = (...content) => el('li', { class: 'empty-state' }, ...content);

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

const AREAS = {
  console: { name: 'Console', icon: 'console' },
  players: { name: 'Players', icon: 'players' },
  worlds: { name: 'Worlds', icon: 'worlds' },
  server: { name: 'Server', icon: 'server' },
  schedule: { name: 'Schedule', icon: 'schedule' },
};
// Old bookmarks keep working.
const ALIASES = { backups: 'worlds', updates: 'server/updates' };
const tabLoaders = {};
const viewLoaders = {};

function currentView(area) {
  return document.querySelector(`#tab-${area} .subnav [aria-selected=true]`)?.dataset.view || null;
}

function showView(area, view) {
  const section = $(`tab-${area}`);
  const tabs = section?.querySelectorAll('.subnav [role=tab]');
  if (!tabs?.length) return;
  if (![...tabs].some((t) => t.dataset.view === view)) view = tabs[0].dataset.view;
  for (const t of tabs) t.setAttribute('aria-selected', t.dataset.view === view);
  for (const v of section.querySelectorAll(':scope > .view')) v.hidden = v.dataset.view !== view;
  viewLoaders[`${area}/${view}`]?.();
}

function showTab(route) {
  route = ALIASES[route] || route || '';
  let [name, view] = route.split('/');
  if (!AREAS[name]) name = 'console';
  document.body.dataset.area = name;
  $('area-name').textContent = AREAS[name].name;
  $('area-icon').setAttribute('href', `#pg-${AREAS[name].icon}`);
  document.title = `${AREAS[name].name} · rconsole`;
  for (const b of document.querySelectorAll('[role=tab]')) {
    const on = b.dataset.tab === name;
    b.setAttribute('aria-selected', on);
    b.tabIndex = on ? 0 : -1;
  }
  for (const s of document.querySelectorAll('.area')) s.hidden = s.id !== `tab-${name}`;
  $('main').scrollTop = 0;
  tabLoaders[name]?.();
  showView(name, view);
  const hash = currentView(name) ? `${name}/${currentView(name)}` : name;
  if (location.hash.slice(1) !== hash) history.replaceState(null, '', `#${hash}`);
  if (name === 'console') scrollLog(true);
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('.subnav [role=tab]');
  if (!t) return;
  const area = t.closest('.area').id.slice(4);
  showView(area, t.dataset.view);
  history.replaceState(null, '', `#${area}/${t.dataset.view}`);
});

window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));
const nav = document.querySelector('.nav');
nav.addEventListener('click', (e) => {
  const b = e.target.closest('[role=tab]');
  if (b) showTab(b.dataset.tab);
});
nav.addEventListener('keydown', (e) => {
  const tabs = [...nav.querySelectorAll('[role=tab]')];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const next = tabs[(i + step + tabs.length) % tabs.length];
  next.focus();
  showTab(next.dataset.tab);
});

// "/" jumps to the command line from anywhere outside a text field.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, textarea, select, [contenteditable], dialog')) return;
  e.preventDefault();
  if (document.body.dataset.area !== 'console') showTab('console');
  $('cmd').focus();
});

// ---------------------------------------------------------------------------
// Console: live log + command line
// ---------------------------------------------------------------------------

const log = $('log');
const MAX_LINES = 3000;
const history_ = [];
let histPos = 0;
let following = true;
let view = 'all';

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
  if (view === 'chat' && !/\b(chat|join|leave|cmd|reply)\b/.test(div.className)) return false;
  return !q || div.textContent.toLowerCase().includes(q);
}

function scrollLog(force) {
  if (force || following) log.scrollTop = log.scrollHeight;
}

function setFollowing(on) {
  following = on;
  $('follow').setAttribute('aria-pressed', on);
  $('follow-icon').setAttribute('href', on ? '#pg-pause' : '#pg-play');
  $('follow-label').textContent = on ? 'Pause scroll' : 'Follow log';
  $('follow').setAttribute('aria-label', on ? 'Pause scrolling' : 'Follow the log');
  if (on) scrollLog(true);
}

function addLine(text, cls = classify(text)) {
  log.querySelector('.log-empty')?.remove();
  const div = el('div', { class: cls }, text);
  div.hidden = !visible(div);
  log.append(div);
  while (log.childElementCount > MAX_LINES) log.firstElementChild.remove();
  scrollLog();
}

function refilter() {
  for (const div of log.children) if (!div.classList.contains('log-empty')) div.hidden = !visible(div);
  scrollLog(true);
}

$('filter').addEventListener('input', refilter);
document.querySelector('.segmented').addEventListener('click', (e) => {
  const b = e.target.closest('[role=radio]');
  if (!b) return;
  view = b.dataset.view;
  for (const r of b.parentElement.children) r.setAttribute('aria-checked', r === b);
  refilter();
});
$('follow').addEventListener('click', () => setFollowing(!following));
$('clear-log').addEventListener('click', () => log.replaceChildren(el('div', { class: 'log-empty' }, 'Cleared. New lines appear as the server writes them.')));
log.addEventListener('scroll', () => {
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  if (atBottom !== following) setFollowing(atBottom);
});

function setLogStatus(error) {
  $('log-status').hidden = !error;
  $('log-status-text').textContent = error ? `Can't read the server log: ${error}` : '';
}

function connectLogs() {
  const source = new EventSource('/api/logs');
  source.addEventListener('backlog', (e) => {
    const { lines, error } = JSON.parse(e.data);
    log.replaceChildren();
    setLogStatus(error);
    if (!lines.length) log.append(el('div', { class: 'log-empty' }, 'Waiting for the server log…'));
    lines.forEach((l) => addLine(l));
  });
  source.addEventListener('line', (e) => addLine(JSON.parse(e.data)));
  source.addEventListener('status', (e) => setLogStatus(JSON.parse(e.data).error));
  // EventSource retries on its own; check whether we were signed out.
  source.addEventListener('error', () => api('GET', '/api/me').catch(() => {}));
}

async function run(command) {
  addLine(`/${command}`, 'cmd');
  try {
    const { output } = await api('POST', '/api/command', { command });
    addLine(output || 'Done, no output.', 'reply');
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
  setFollowing(true);
  run(cmd.replace(/^\//, ''));
});

$('cmd').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' && histPos > 0) $('cmd').value = history_[--histPos];
  else if (e.key === 'ArrowDown') {
    histPos = Math.min(history_.length, histPos + 1);
    $('cmd').value = history_[histPos] || '';
  } else if (e.key === 'Escape') $('cmd').blur();
  else return;
  e.preventDefault();
});

document.querySelectorAll('[data-c]').forEach((b) => b.addEventListener('click', () => busy(b, () => run(b.dataset.c))));

// ---------------------------------------------------------------------------
// Health, online players, restart countdown
// ---------------------------------------------------------------------------

let countdownEnd = null;

// Nominal readouts stay neutral; only off-nominal ones are marked, so the
// strip never borrows an area's colour.
function readout(id, content, cls = '') {
  const off = cls === 'meh' || cls === 'bad';
  $(id).replaceChildren(...(off ? [icon('alert')] : []), ...[].concat(content));
  $(id).className = off ? cls : '';
  $(id).parentElement.classList.toggle('off', off);
  $(id).parentElement.title = cls === 'bad' ? 'Critical' : cls === 'meh' ? 'Needs attention' : '';
}

const POWER_LABEL = {
  active: 'Running',
  inactive: 'Stopped',
  failed: 'Crashed',
  activating: 'Starting…',
  deactivating: 'Stopping…',
  reloading: 'Reloading…',
};

let lastStatus = null;

function renderStatus(s) {
  lastStatus = s;
  const { game, host, rcon, power = {} } = s;
  const conn = $('conn');
  const stopped = power.available && power.active !== 'active';
  conn.dataset.state = rcon.ok ? 'ok' : 'down';
  $('status').textContent = rcon.ok ? 'Online' : stopped ? `Server ${POWER_LABEL[power.active]?.toLowerCase() || power.active}` : 'RCON offline';
  conn.title = rcon.ok ? 'Server running, RCON connected' : rcon.error || '';
  $('maint-badge').hidden = !s.maintenance?.enabled;
  renderPower(s);
  renderOp(s.op);

  if (game?.tps != null) {
    readout('s-tps', [game.tps.toFixed(1), game.mspt != null ? el('small', {}, ` ${game.mspt.toFixed(1)} ms`) : ''], game.tps >= 19 ? 'good' : game.tps >= 15 ? 'meh' : 'bad');
  } else readout('s-tps', game ? 'n/a' : '–');
  readout('s-players', game?.players ? [String(game.players.online), el('small', {}, ` / ${game.players.max}`)] : '–');
  readout('s-time', game?.daytime != null ? [fmt.gameTime(game.daytime), game.day != null ? el('small', {}, ` day ${game.day}`) : ''] : '–');
  readout('s-cpu', host.cpu != null ? fmt.pct(host.cpu) : '–', host.cpu != null ? level(host.cpu, 0.7, 0.9) : '');
  const memUsed = 1 - host.mem.available / host.mem.total;
  readout('s-mem', [fmt.bytes(host.mem.total - host.mem.available), el('small', {}, ` / ${fmt.bytes(host.mem.total)}`)], level(memUsed, 0.8, 0.92));
  if (host.disk) readout('s-disk', fmt.bytes(host.disk.available), level(1 - host.disk.available / host.disk.total, 0.8, 0.92));
  readout('s-uptime', fmt.duration(host.uptime));

  const players = game?.players?.players || [];
  $('count').textContent = game?.players ? `${game.players.online} / ${game.players.max}` : '';
  $('online').replaceChildren(
    ...(players.length
      ? players.map((name) =>
          el('li', { title: `Insert ${name} into the command line`, onclick: () => insertName(name) },
            avatar(name), el('span', { class: 'who-cell' }, el('span', { class: 'name' }, name))))
      : [emptyItem(rcon.ok ? 'Nobody is online. Click a player here to insert their name into a command.' : 'Player list unavailable while RCON is offline.')])
  );

  const remaining = s.restart?.remaining;
  countdownEnd = remaining != null ? Date.now() + remaining * 1000 : null;
  countdownVerb = s.restart?.verb || 'restarting';
  tickCountdown();

  renderBackupState(s.backup);
  renderUpdateState(s.update);
}

function insertName(name) {
  const input = $('cmd');
  input.value = input.value ? `${input.value.replace(/\s*$/, ' ')}${name}` : name;
  input.focus();
}

let countdownVerb = 'restarting';
function tickCountdown() {
  const left = countdownEnd ? Math.max(0, Math.round((countdownEnd - Date.now()) / 1000)) : null;
  $('restart-banner').hidden = left == null;
  if (left == null) return;
  $('restart-left').textContent = fmt.countdown(left);
  $('restart-verb').textContent = countdownVerb === 'stopping' ? 'Server stops in' : 'Server restarts in';
  $('restart-cancel').textContent = countdownVerb === 'stopping' ? 'Cancel stop' : 'Cancel restart';
}

// --- running operation (world switch, restore, power) ---
let opWasRunning = false;
function renderOp(op) {
  if (!op) return;
  const bar = $('op-bar');
  const recentFail = op.error && Date.now() - Date.parse(op.finishedAt) < 60000;
  bar.hidden = !op.running && !recentFail;
  bar.dataset.state = op.running ? 'running' : 'failed';
  $('op-icon').setAttribute('href', op.running ? '#pg-server' : '#pg-alert');
  $('op-text').textContent = op.running ? `${op.label}: ${op.step}…` : recentFail ? `${op.label} failed: ${op.error}` : '';
  if (opWasRunning && !op.running) {
    toast(op.error ? `${op.label} failed: ${op.error}` : `${op.label}: done.`, op.error ? 'bad' : 'ok');
    if (document.body.dataset.area === 'worlds') loadWorldsArea();
  }
  opWasRunning = op.running;
  document.querySelectorAll('[data-op]').forEach((b) => (b.disabled = op.running));
}
setInterval(tickCountdown, 1000);

let statusTimer;
async function refreshStatus(soon) {
  clearTimeout(statusTimer);
  if (soon) await new Promise((r) => setTimeout(r, 300));
  try {
    renderStatus(await api('GET', '/api/status'));
  } catch (e) {
    $('conn').dataset.state = 'down';
    $('status').textContent = e.message;
  }
  statusTimer = setTimeout(refreshStatus, 5000);
}

$('restart-start').addEventListener('click', async (e) => {
  const btn = e.currentTarget; // reset to null once the handler awaits
  const seconds = Number($('restart-delay').value);
  const ok = await confirmAction({
    title: `Restart in ${fmt.delay(seconds)}?`,
    body: 'Players are warned in chat with a countdown. The world is saved, the server stops and comes back on its own.',
    confirm: 'Start countdown',
    tone: 'primary',
    icon: 'restart',
  });
  if (!ok) return;
  await busy(btn, async () => {
    try {
      await api('POST', '/api/restart', { seconds });
      addLine(`Restart countdown started: ${fmt.delay(seconds)}.`, 'sys');
      toast(`Restart countdown started: ${fmt.delay(seconds)}.`);
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
  refreshStatus();
});

$('restart-cancel').addEventListener('click', async (e) => {
  await busy(e.currentTarget, () =>
    api('DELETE', '/api/restart').then(() => toast('Restart cancelled. Players were told in chat.')).catch((err) => toast(err.message, 'bad')));
  refreshStatus();
});

// ---------------------------------------------------------------------------
// Players: whitelist, ops, bans
// ---------------------------------------------------------------------------

let accessLoaded = false;

function personRow(p, meta, action) {
  return el('li', {},
    avatar(p.uuid || p.name),
    el('span', { class: 'who-cell' }, el('span', { class: 'name' }, p.name), meta ? el('span', { class: 'meta' }, meta) : null),
    action);
}

function rowAction(label, iconName, command, confirmOpts) {
  const btn = el('button', { class: 'btn btn-quiet btn-sm danger', title: label }, icon(iconName), label);
  btn.addEventListener('click', async () => {
    if (confirmOpts && !(await confirmAction(confirmOpts))) return;
    busy(btn, () => mutate(command));
  });
  return btn;
}

const banMeta = (b) => [b.reason && b.reason !== 'Banned by an operator.' ? b.reason : null, b.source && `by ${b.source}`, b.expires && b.expires !== 'forever' ? `until ${b.expires}` : null].filter(Boolean).join(' · ');

async function loadAccess() {
  if (!accessLoaded) ['list-whitelist', 'list-ops', 'list-bans', 'list-ipbans'].forEach((id) => skeletonList($(id)));
  try {
    const a = await api('GET', '/api/access');
    accessLoaded = true;
    $('access-error').hidden = true;
    $('wl-toggle').checked = a.whitelistEnabled;
    $('wl-state').textContent = a.whitelistEnabled ? 'On' : 'Off';
    $('n-whitelist').textContent = a.whitelist.length || '';
    $('n-ops').textContent = a.ops.length || '';
    $('n-bans').textContent = a.bans.length || '';
    $('n-ipbans').textContent = a.ipBans.length || '';

    $('list-whitelist').replaceChildren(...(a.whitelist.length
      ? a.whitelist.map((p) => personRow(p, null, rowAction('Remove', 'remove', `whitelist remove ${p.name}`)))
      : [emptyItem(a.whitelistEnabled ? 'Nobody is whitelisted, so nobody can join. Add players above.' : 'The whitelist is off, so anyone can join. Add players, then switch it on.')]));
    $('list-ops').replaceChildren(...(a.ops.length
      ? a.ops.map((p) => personRow(p, `Permission level ${p.level}`, rowAction('Deop', 'remove', `deop ${p.name}`, { title: `Remove operator rights from ${p.name}?`, confirm: 'Deop', tone: 'danger', icon: 'op' })))
      : [emptyItem('No operators. Operators can run every command in game.')]));
    $('list-bans').replaceChildren(...(a.bans.length
      ? a.bans.map((b) => personRow(b, banMeta(b), rowAction('Unban', 'check', `pardon ${b.name}`)))
      : [emptyItem('No banned players.')]));
    $('list-ipbans').replaceChildren(...(a.ipBans.length
      ? a.ipBans.map((b) => el('li', {},
          el('span', { class: 'ip-tile' }, icon('ban')),
          el('span', { class: 'who-cell' }, el('span', { class: 'name mono' }, b.ip), el('span', { class: 'meta' }, banMeta(b) || 'No reason given')),
          rowAction('Unban', 'check', `pardon-ip ${b.ip}`)))
      : [emptyItem('No banned IP addresses.')]));
  } catch (e) {
    $('access-error').hidden = false;
    $('access-error').textContent = `Can't read the player lists: ${e.message}`;
  }
}
tabLoaders.players = loadAccess;

async function mutate(command) {
  try {
    const { output } = await api('POST', '/api/command', { command });
    addLine(`/${command}`, 'cmd');
    addLine(output || 'Done, no output.', 'reply');
    toast(output || `/${command}`);
  } catch (e) {
    toast(e.message, 'bad');
  }
  await new Promise((r) => setTimeout(r, 400)); // the server writes its JSON files asynchronously
  await loadAccess();
}

$('wl-toggle').addEventListener('change', (e) => mutate(`whitelist ${e.target.checked ? 'on' : 'off'}`));

const CONFIRM_ADD = {
  op: (v) => ({ title: `Make ${v} an operator?`, body: 'Operators can run every command in game, including stopping the server.', confirm: 'Make op', tone: 'primary', icon: 'op' }),
  ban: (v, reason) => ({ title: `Ban ${v}?`, body: `${v} is kicked and can't join until unbanned.${reason ? `\nReason: ${reason}` : ''}`, confirm: 'Ban', tone: 'danger', icon: 'ban' }),
};

document.querySelectorAll('form.add').forEach((form) => {
  const input = form.querySelector('input:not([data-reason])');
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const reason = form.querySelector('[data-reason]')?.value.trim();
    const value = input.value.trim();
    const ok = form.dataset.kind === 'player' ? PLAYER_RE.test(value) : /^[\w.:]+$/.test(value);
    if (!ok) {
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return toast(form.dataset.kind === 'player' ? 'Player names are 1–16 letters, digits or underscores.' : 'Enter an IP address or the name of an online player.', 'bad');
    }
    const confirmOpts = CONFIRM_ADD[form.dataset.confirm]?.(value, reason);
    if (confirmOpts && !(await confirmAction(confirmOpts))) return;
    const command = form.dataset.cmd.replace('{v}', value) + (reason ? ` ${reason}` : '');
    form.reset();
    busy(form.querySelector('button'), () => mutate(command));
  });
});

// ---------------------------------------------------------------------------
// Worlds & backups
// ---------------------------------------------------------------------------

let backupWasRunning = false;
let backupsLoaded = false;
let worldsLoaded = false;
let worldNames = [];
let activeWorldName = null;

function setJob(box, state, iconName, text) {
  box.hidden = !state;
  if (!state) return;
  box.dataset.state = state;
  box.replaceChildren(icon(iconName), el('span', {}, text));
}

const DELAYS = [[0, 'Now'], [10, 'In 10 seconds'], [60, 'In 1 minute'], [300, 'In 5 minutes']];
function delaySelect(selected = 60) {
  return el('select', { class: 'field', name: 'seconds' }, ...DELAYS.map(([v, l]) => el('option', { value: v, selected: v === selected || undefined }, l)));
}
const fld = (label, control) => el('label', { class: 'fld' }, el('span', {}, label), control);
const serverRunning = () => !lastStatus?.power?.available || lastStatus.power.active === 'active';

function renderBackupState(state) {
  if (!state) return;
  const btn = $('backup-now');
  btn.disabled = state.running;
  btn.querySelector('span').textContent = state.running ? 'Backing up…' : 'Back up active world';
  if (state.running) setJob($('backup-state'), 'running', 'backups', `Backing up ${state.world || 'the active world'}. Started ${fmt.relative(state.startedAt)}; autosave is paused until it finishes.`);
  else if (state.lastError) setJob($('backup-state'), 'failed', 'alert', `The last backup failed: ${state.lastError}`);
  else setJob($('backup-state'), null);
  if (backupWasRunning && !state.running) {
    loadBackups();
    if (state.lastError) toast(`Backup failed: ${state.lastError}`, 'bad');
    else toast(`Backup created: ${state.lastFile}`);
  }
  backupWasRunning = state.running;
}

async function loadWorlds() {
  if (!worldsLoaded) skeletonRows($('world-list'), 5);
  try {
    const { active, worlds } = await api('GET', '/api/worlds');
    worldsLoaded = true;
    activeWorldName = active;
    worldNames = worlds.map((w) => w.name);
    const total = worlds.reduce((n, w) => n + w.size, 0);
    $('worlds-info').textContent = `${worlds.length} world${worlds.length === 1 ? '' : 's'}, ${fmt.bytes(total)}. The server plays one world at a time.`;
    $('world-list').replaceChildren(...worlds.map((w) => el('tr', {},
      el('td', { class: 'primary-cell', 'data-label': 'World' },
        w.name, ' ', w.active ? el('span', { class: 'pill own' }, icon('check'), 'Active') : null,
        el('span', { class: 'sub' }, [w.type && w.type !== 'normal' ? w.type.replace('_', ' ') : null, w.seed ? `seed ${w.seed}` : null, !w.generated ? 'generated on next start' : null].filter(Boolean).join(' · ') || null)),
      el('td', { 'data-label': 'Dimensions' }, el('span', { class: 'dims' }, ...w.dimensions.map((d) => el('span', { class: 'pill' }, d.replace('the_end', 'end'))))),
      el('td', { class: 'num', 'data-label': 'Size' }, w.generated ? fmt.bytes(w.size) : '–'),
      el('td', { 'data-label': 'Last played' }, w.lastPlayed ? [fmt.date(w.lastPlayed), el('span', { class: 'sub' }, fmt.relative(w.lastPlayed))] : '–'),
      el('td', { class: 'act' },
        w.active ? null : worldButton('Switch', 'play', () => switchWorld(w.name)),
        w.generated ? worldButton('Back up', 'backups', () => backupWorld(w.name)) : null,
        w.active ? null : worldButton('Delete', 'delete', () => deleteWorld(w.name), true)))));
  } catch (e) {
    $('world-list').replaceChildren(emptyRow(5, `Can't list worlds: ${e.message}`));
  }
}

function worldButton(label, iconName, fn, danger) {
  const btn = el('button', { class: `btn btn-quiet btn-sm${danger ? ' danger' : ''}`, 'data-op': true, disabled: lastStatus?.op?.running || undefined }, icon(iconName), label);
  btn.addEventListener('click', () => busy(btn, fn));
  return btn;
}

async function startOp(url, body, okMessage) {
  try {
    const st = await api('POST', url, body);
    renderOp(st.running !== undefined ? st : st.op);
    if (okMessage) toast(okMessage);
    refreshStatus(true);
  } catch (e) {
    toast(e.message, 'bad');
  }
}

async function switchWorld(name) {
  const delay = delaySelect(60);
  const running = serverRunning();
  if (!(await confirmAction({
    title: `Switch to ${name}?`,
    body: running ? `The server restarts into ${name}. ${activeWorldName} stays on disk and you can switch back any time.` : `${name} is played from the next start.`,
    confirm: 'Switch world', icon: 'worlds',
    content: running ? fld('Restart', delay) : null,
  }))) return;
  await startOp(`/api/worlds/${encodeURIComponent(name)}/activate`, { seconds: Number(delay.value) });
}

async function backupWorld(name) {
  try {
    renderBackupState((await api('POST', '/api/backups', { world: name })).state);
  } catch (e) {
    toast(e.message, 'bad');
  }
}

async function deleteWorld(name) {
  const archive = el('input', { type: 'checkbox', checked: true });
  if (!(await confirmAction({
    title: `Delete world ${name}?`,
    body: 'Removes the overworld, nether and end folders of this world.',
    confirm: 'Delete world', tone: 'danger', icon: 'delete',
    content: el('label', { class: 'check' }, archive, el('span', {}, 'Archive it as a backup first')),
  }))) return;
  try {
    const st = await api('DELETE', `/api/worlds/${encodeURIComponent(name)}?archive=${archive.checked ? 1 : 0}`);
    renderOp(st);
  } catch (e) {
    toast(e.message, 'bad');
  }
}

const worldForm = $('world-new');
function toggleWorldForm(open) {
  worldForm.hidden = !open;
  $('world-new-toggle').setAttribute('aria-expanded', open);
  if (open) worldForm.elements.name.focus();
}
$('world-new-toggle').addEventListener('click', () => toggleWorldForm(worldForm.hidden));
$('world-new-cancel').addEventListener('click', () => toggleWorldForm(false));
worldForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = worldForm.elements;
  const name = f.name.value.trim();
  if (worldNames.includes(name)) return toast(`A world named ${name} already exists.`, 'bad');
  await busy(worldForm.querySelector('.btn-primary'), () =>
    startOp('/api/worlds', { name, seed: f.seed.value.trim(), type: f.type.value, seconds: Number(f.seconds.value) }, `Creating ${name}. The server switches to it ${serverRunning() ? 'after the countdown' : 'on next start'}.`));
  worldForm.reset();
  toggleWorldForm(false);
});

async function loadBackups() {
  if (!backupsLoaded) skeletonRows($('backup-list'), 5);
  try {
    const { dir, keep, files, state } = await api('GET', '/api/backups');
    backupsLoaded = true;
    const total = files.reduce((n, f) => n + f.size, 0);
    $('backup-info').textContent = `${files.length} backup${files.length === 1 ? '' : 's'}, ${fmt.bytes(total)} in ${dir}. ${keep ? `The newest ${keep} of each world are kept.` : 'All backups are kept.'}`;
    renderBackupState(state);
    const seen = new Set();
    $('backup-list').replaceChildren(...(files.length
      ? files.map((f) => {
          const latest = !seen.has(f.world) && seen.add(f.world);
          return el('tr', {},
            el('td', { class: 'primary-cell', 'data-label': 'Backup' }, el('span', { class: 'filename' }, f.name), latest ? el('span', { class: 'sub' }, `Latest of ${f.world}`) : null),
            el('td', { 'data-label': 'World' }, f.world),
            el('td', { class: 'num', 'data-label': 'Size' }, fmt.bytes(f.size)),
            el('td', { 'data-label': 'Created' }, fmt.date(f.created), el('span', { class: 'sub' }, fmt.relative(f.created))),
            el('td', { class: 'act' },
              worldButton('Restore', 'rollback', () => restoreBackup(f)),
              el('a', { class: 'btn btn-quiet btn-sm', href: `/api/backups/${encodeURIComponent(f.name)}`, download: f.name }, icon('download'), 'Download'),
              deleteBackupButton(f.name)));
        })
      : [emptyRow(5, el('b', {}, 'No backups yet. '), 'A backup archives a world with its nether and end into a .tar.gz while autosave is paused. Add a nightly backup under Schedule.')]));
  } catch (e) {
    $('backup-list').replaceChildren(emptyRow(5, `Can't list backups: ${e.message}`));
  }
}

async function restoreBackup(f) {
  const isActive = f.world === activeWorldName;
  const exists = worldNames.includes(f.world);
  const target = el('input', { class: 'field', value: `${f.world}-restored`.slice(0, 32), maxlength: 32, 'aria-label': 'New world name' });
  const delay = delaySelect(60);
  const radio = (value, title, note, checked) => el('label', { class: 'radio-row' },
    el('input', { type: 'radio', name: 'restore-mode', value, checked: checked || undefined }),
    el('span', {}, el('b', {}, title), el('span', { class: 'note' }, note)));
  const replace = radio('replace', exists ? `Replace ${f.world}` : `Restore ${f.world}`,
    !exists ? 'Recreates the deleted world.'
      : isActive ? 'The server stops, the current world is backed up for safety, then the backup is restored and the server starts again.'
        : 'The current folders are backed up for safety, then overwritten.', true);
  const asNew = radio('new', 'Restore as a new world', 'Extracts next to your other worlds; nothing is stopped or overwritten.');
  const content = el('div', { class: 'stack' }, replace, asNew, fld('New world name', target), isActive && serverRunning() ? fld('Stop the server', delay) : null);
  const sync = () => (target.closest('.fld').hidden = !asNew.querySelector('input').checked);
  content.addEventListener('change', sync);
  sync();
  if (!(await confirmAction({ title: 'Restore backup?', body: f.name, confirm: 'Restore', tone: 'danger', icon: 'rollback', content }))) return;
  const mode = asNew.querySelector('input').checked ? 'new' : 'replace';
  await startOp(`/api/backups/${encodeURIComponent(f.name)}/restore`, { mode, target: mode === 'new' ? target.value.trim() : undefined, seconds: Number(delay.value) });
}

function deleteBackupButton(name) {
  const btn = el('button', { class: 'btn btn-quiet btn-sm danger', 'aria-label': `Delete ${name}` }, icon('delete'), 'Delete');
  btn.addEventListener('click', async () => {
    if (!(await confirmAction({ title: 'Delete this backup?', body: `${name}\nThis can't be undone.`, confirm: 'Delete backup', tone: 'danger', icon: 'delete' }))) return;
    await busy(btn, () => api('DELETE', `/api/backups/${encodeURIComponent(name)}`).then(() => toast(`Deleted ${name}`)).catch((e) => toast(e.message, 'bad')));
    loadBackups();
  });
  return btn;
}

$('backup-now').addEventListener('click', async (e) => {
  await busy(e.currentTarget, async () => {
    try {
      renderBackupState((await api('POST', '/api/backups', {})).state);
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
});

function loadWorldsArea() {
  loadWorlds();
  loadBackups();
}
tabLoaders.worlds = loadWorldsArea;

// ---------------------------------------------------------------------------
// Server: power & maintenance
// ---------------------------------------------------------------------------

function renderPower(s) {
  const p = s.power || {};
  const box = $('power-state');
  const state = p.available ? p.active : 'unknown';
  box.dataset.state = state;
  $('power-label').textContent = p.available ? POWER_LABEL[p.active] || p.active : 'Not controllable';
  $('power-detail').textContent = !p.available
    ? ` · ${p.error || `rconsole can't control ${p.unit || 'the server service'}. See the README (polkit rule).`}`
    : p.active === 'active' && p.since ? ` · since ${fmt.date(p.since)} (${fmt.relative(p.since)})${p.pid ? ` · PID ${p.pid}` : ''}`
      : p.active === 'failed' ? ` · ${p.result}` : '';
  const busyNow = Boolean(p.pending) || s.op?.running || s.restart?.remaining != null;
  $('power-start').disabled = !p.available || p.active === 'active' || busyNow;
  $('power-stop').disabled = !p.available || p.active !== 'active' || busyNow;
  $('power-restart').disabled = !p.available || p.active !== 'active' || busyNow;
  const m = s.maintenance || {};
  $('maint-toggle').checked = Boolean(m.enabled);
  $('maint-state').textContent = m.enabled ? 'On' : 'Off';
  $('maint-info').textContent = m.enabled
    ? `On since ${fmt.date(m.since)}. Only operators can join. Switching it off restores the whitelist.`
    : 'Only operators can stay or join. Whitelisted players are taken off the whitelist and kicked, and put back when you switch it off.';
}

async function power(action) {
  const seconds = Number($('power-delay').value);
  if (action !== 'start') {
    const ok = await confirmAction({
      title: action === 'stop' ? `Stop the server${seconds ? ` in ${fmt.delay(seconds)}` : ' now'}?` : `Restart the server${seconds ? ` in ${fmt.delay(seconds)}` : ' now'}?`,
      body: action === 'stop' ? 'Players are warned, the world is saved and the server stays off until you start it.' : 'Players are warned, the world is saved and the server comes straight back.',
      confirm: action === 'stop' ? 'Stop server' : 'Restart server',
      tone: action === 'stop' ? 'danger' : 'primary',
      icon: action === 'stop' ? 'stop' : 'restart',
    });
    if (!ok) return;
  }
  await startOp('/api/server/power', { action, seconds });
}
$('power-start').addEventListener('click', (e) => busy(e.currentTarget, () => power('start')));
$('power-stop').addEventListener('click', (e) => busy(e.currentTarget, () => power('stop')));
$('power-restart').addEventListener('click', (e) => busy(e.currentTarget, () => power('restart')));

$('maint-toggle').addEventListener('change', async (e) => {
  const on = e.target.checked;
  e.target.checked = !on; // reflect the server's answer, not the click
  if (on && !(await confirmAction({
    title: 'Turn on maintenance mode?',
    body: 'Non-operators are taken off the whitelist and kicked with your message. Switching it off puts the whitelist back exactly as it was.',
    confirm: 'Turn on', tone: 'danger', icon: 'maintenance',
  }))) return;
  try {
    const r = await api('POST', '/api/maintenance', { enabled: on, message: $('maint-message').value });
    toast(on ? `Maintenance on. ${r.removed.length} taken off the whitelist, ${r.kicked.length} kicked.` : `Maintenance off. ${r.restored.length} restored to the whitelist.`);
  } catch (err) {
    toast(err.message, 'bad');
  }
  refreshStatus(true);
});

tabLoaders.server = () => lastStatus && renderPower(lastStatus);

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TYPE = {
  restart: { label: 'Restart', icon: 'restart' },
  backup: { label: 'Backup', icon: 'backups' },
  command: { label: 'Command', icon: 'console' },
};
let tasksLoaded = false;

function describeDays(days) {
  if (!days.length || days.length === 7) return 'Daily';
  if (days.join() === '1,2,3,4,5') return 'Weekdays';
  if (days.join() === '0,6') return 'Weekends';
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_NAMES[d]).join(', ');
}

async function loadTasks() {
  if (!tasksLoaded) skeletonRows($('task-list'), 5);
  try {
    const { tasks } = await api('GET', '/api/tasks');
    tasksLoaded = true;
    $('n-tasks').textContent = tasks.length || '';
    $('task-list').replaceChildren(...(tasks.length
      ? tasks.map((t) => {
          const detail = t.type === 'command' ? `/${t.command}` : t.type === 'restart' ? `${t.warnMinutes} min warning` : 'World, nether and end';
          const failed = /^error/i.test(t.lastResult || '');
          return el('tr', {},
            el('td', { class: 'primary-cell', 'data-label': 'Task' },
              t.name || TYPE[t.type].label, ' ',
              el('span', { class: `pill ${t.enabled ? 'own' : ''}` }, t.enabled ? 'Active' : 'Paused'),
              el('span', { class: `sub ${t.type === 'command' ? 'mono' : ''}` }, detail)),
            el('td', { 'data-label': 'When' }, `${t.time}`, el('span', { class: 'sub' }, describeDays(t.days))),
            el('td', { 'data-label': 'Next run' }, t.enabled && t.nextRun ? [fmt.date(t.nextRun), el('span', { class: 'sub' }, fmt.relative(t.nextRun))] : '–'),
            el('td', { 'data-label': 'Last result' }, t.lastRun
              ? el('span', { class: `result ${failed ? 'bad' : ''}` }, t.lastResult, el('span', { class: 'sub' }, fmt.relative(t.lastRun)))
              : el('span', { class: 'result' }, 'Not run yet')),
            el('td', { class: 'act' },
              taskButton(t.enabled ? 'Pause' : 'Resume', t.enabled ? 'pause' : 'play', () => taskAction('PATCH', t, { enabled: !t.enabled })),
              taskButton('Run now', 'play', () => runTask(t)),
              taskButton('Delete', 'delete', async () => {
                if (await confirmAction({ title: `Delete “${t.name || TYPE[t.type].label}”?`, body: `${TYPE[t.type].label} at ${t.time}, ${describeDays(t.days).toLowerCase()}.`, confirm: 'Delete task', tone: 'danger', icon: 'delete' })) await taskAction('DELETE', t);
              }, true)));
        })
      : [emptyRow(5, el('b', {}, 'No scheduled tasks. '), 'A nightly restart at 04:00 and a backup at 04:30 keep the server fresh and recoverable.')]));
  } catch (e) {
    $('task-list').replaceChildren(emptyRow(5, `Can't load tasks: ${e.message}`));
  }
}
tabLoaders.schedule = loadTasks;

function taskButton(label, iconName, fn, danger) {
  const btn = el('button', { class: `btn btn-quiet btn-sm${danger ? ' danger' : ''}` }, icon(iconName), label);
  btn.addEventListener('click', () => busy(btn, fn));
  return btn;
}

async function taskAction(method, task, body) {
  try {
    await api(method, `/api/tasks/${task.id}`, body);
    if (method === 'DELETE') toast('Task deleted.');
    else toast(body.enabled ? 'Task resumed.' : 'Task paused.');
  } catch (e) {
    toast(e.message, 'bad');
  }
  await loadTasks();
}

async function runTask(task) {
  const label = task.name || TYPE[task.type].label;
  const opts = task.type === 'restart'
    ? { title: `Restart now?`, body: `Starts the ${task.warnMinutes}-minute countdown with chat warnings, then restarts the server.`, confirm: 'Start countdown', tone: 'primary', icon: 'restart' }
    : { title: `Run “${label}” now?`, body: task.type === 'command' ? `/${task.command}` : 'Takes a world backup now.', confirm: 'Run now', tone: 'primary', icon: TYPE[task.type].icon };
  if (!(await confirmAction(opts))) return;
  try {
    await api('POST', `/api/tasks/${task.id}/run`);
    toast(`Started “${label}”.`);
  } catch (e) {
    toast(e.message, 'bad');
  }
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
  await busy(taskForm.querySelector('.form-actions .btn'), async () => {
    try {
      await api('POST', '/api/tasks', body);
      $('task-error').textContent = '';
      f.name.value = '';
      f.command.value = '';
      toast(`${TYPE[body.type].label} scheduled at ${body.time}, ${describeDays(body.days).toLowerCase()}.`);
      await loadTasks();
    } catch (err) {
      $('task-error').textContent = err.message;
    }
  });
});

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

let updateWasRunning = false;
let updateBusy = false;
let updatesLoaded = false;

function renderUpdateState(st) {
  if (!st) return;
  updateBusy = st.running;
  if (st.running) setJob($('upd-status'), 'running', 'updates', `Updating to ${st.target}: ${st.step}…`);
  else if (st.error) setJob($('upd-status'), 'failed', 'alert', `Update to ${st.target} failed: ${st.error}`);
  else if (st.finishedAt) setJob($('upd-status'), 'done', 'check', `Updated to ${st.target} ${fmt.relative(st.finishedAt)}.`);
  else setJob($('upd-status'), null);
  document.querySelectorAll('[data-update]').forEach((b) => (b.disabled = st.running));
  $('upd-rollback').disabled = st.running;
  if (updateWasRunning && !st.running) {
    loadUpdates();
    if (st.error) toast(`Update failed: ${st.error}`, 'bad');
    else toast(`Updated to ${st.target}. The server is restarting.`);
  }
  updateWasRunning = st.running;
}

async function startUpdate(body, opts) {
  const restart = fmt.delay(Number($('upd-delay').value)) || 'now';
  const backup = $('upd-backup').checked && !body.rollback;
  const ok = await confirmAction({
    ...opts,
    body: `${opts.body ? `${opts.body}\n\n` : ''}${backup ? 'The world is backed up first. ' : ''}Players are warned, then the server restarts in ${restart}.`,
  });
  if (!ok) return;
  try {
    const st = await api('POST', '/api/updates', { ...body, backup, restartSeconds: Number($('upd-delay').value) });
    renderUpdateState(st);
    refreshStatus(true);
  } catch (e) {
    toast(e.message, 'bad');
  }
}

async function loadUpdates(refresh) {
  if (!updatesLoaded) { skeletonRows($('upd-builds'), 4); skeletonRows($('upd-versions'), 2); }
  const refreshBtn = $('upd-refresh');
  refreshBtn.setAttribute('aria-busy', 'true');
  try {
    const o = await api('GET', `/api/updates${refresh ? '?refresh' : ''}`);
    updatesLoaded = true;
    $('upd-current').textContent = o.current ? `Paper ${o.current.version} · build ${o.current.build}` : 'Unknown version';
    $('upd-source').textContent = o.error ? `Can't reach PaperMC: ${o.error}` : o.current ? '' : 'Start the server once so its version shows in the log.';
    const latest = o.current && !o.newerBuilds.length;
    $('upd-channel').hidden = !o.current;
    $('upd-channel').className = `pill ${latest ? '' : 'own'}`;
    $('upd-channel').replaceChildren(icon(latest ? 'check' : 'updates'), latest ? 'Latest build' : `${o.newerBuilds.length} update${o.newerBuilds.length === 1 ? '' : 's'} available`);
    $('upd-rollback').hidden = !o.canRollback;
    renderUpdateState(o.state);
    if (refresh) toast(o.error ? `Couldn't check for updates: ${o.error}` : latest ? 'You are on the latest build.' : 'New builds available.', o.error ? 'bad' : 'ok');

    $('upd-builds').replaceChildren(...(o.newerBuilds.length
      ? o.newerBuilds.map((b, i) => el('tr', {},
          el('td', { class: 'primary-cell', 'data-label': 'Build' }, `#${b.id}`, i === 0 ? el('span', { class: 'sub' }, 'Newest') : null),
          el('td', { 'data-label': 'Channel' }, el('span', { class: `pill ${b.channel === 'STABLE' ? 'own' : ''}` }, (b.channel || 'unknown').toLowerCase())),
          el('td', { 'data-label': 'Released' }, b.time ? [fmt.date(b.time), el('span', { class: 'sub' }, fmt.relative(b.time))] : '–'),
          el('td', { class: 'act' }, el('button', {
            class: `btn btn-sm ${i === 0 ? 'btn-primary' : ''}`, 'data-update': true, disabled: updateBusy || undefined,
            onclick: () => startUpdate({ version: o.current.version, build: b.id }, { title: `Update to build ${b.id}?`, body: `Paper ${o.current.version} #${o.current.build} → #${b.id} (${(b.channel || '').toLowerCase()}). The previous jar is kept for rollback.`, confirm: 'Update', icon: 'updates' }),
          }, icon('updates'), 'Update'))))
      : [emptyRow(4, o.current ? [el('b', {}, 'You are on the latest build. '), `Paper ${o.current.version} #${o.current.build}.`] : 'No version information yet.')]));

    $('upd-versions').replaceChildren(...(o.newerVersions.length
      ? o.newerVersions.map((v) => el('tr', {},
          el('td', { class: 'primary-cell', 'data-label': 'Version' }, `Minecraft ${v}`),
          el('td', { class: 'act' }, el('button', { class: 'btn btn-sm', 'data-update': true, disabled: updateBusy || undefined, onclick: (e) => upgradeVersion(v, e.currentTarget) }, icon('updates'), 'Upgrade…'))))
      : [emptyRow(2, o.current ? `Minecraft ${o.current.version} is the newest version Paper supports.` : '–')]));
  } catch (e) {
    $('upd-source').textContent = e.message;
  } finally {
    refreshBtn.removeAttribute('aria-busy');
  }
}
viewLoaders['server/updates'] = () => loadUpdates();

async function upgradeVersion(version, btn) {
  try {
    const { builds } = await busy(btn, () => api('GET', `/api/updates/builds?version=${encodeURIComponent(version)}`));
    if (!builds.length) return toast(`No Paper builds for ${version} yet.`, 'bad');
    const b = builds[0];
    startUpdate({ version, build: b.id }, {
      title: `Upgrade to Minecraft ${version}?`,
      body: `Paper build ${b.id} (${(b.channel || '').toLowerCase()}). This converts the world to ${version}. Rolling back the jar afterwards does not undo that; only restoring the backup does.`,
      confirm: 'Upgrade',
      tone: 'danger',
      icon: 'updates',
    });
  } catch (e) {
    toast(e.message, 'bad');
  }
}

$('upd-refresh').addEventListener('click', () => loadUpdates(true));
$('upd-rollback').addEventListener('click', () => startUpdate({ rollback: true }, { title: 'Roll back to the previous jar?', body: 'Swaps the server jar back to the one before the last update.', confirm: 'Roll back', tone: 'primary', icon: 'rollback' }));

// ---------------------------------------------------------------------------

async function signOut() {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.replace('/login');
}
$('logout').addEventListener('click', signOut);
$('logout-m').addEventListener('click', signOut);
api('GET', '/api/me').then(({ user }) => ($('me').textContent = user)).catch(() => {});

connectLogs();
refreshStatus();
showTab(location.hash.slice(1));
syncTaskForm();

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
  node.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== ''));
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
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (HTTP ${res.status})`), { status: res.status, data });
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
  // Today 22:52, Yesterday 08:10, then Oct 12, 2026, 4:13 PM.
  date(iso) {
    if (!iso) return '–';
    const d = new Date(iso);
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const ago = Math.round((day(new Date()) - day(d)) / 86400000);
    const time = d.toLocaleTimeString(undefined, { timeStyle: 'short' });
    if (ago === 0) return `Today ${time}`;
    if (ago === 1) return `Yesterday ${time}`;
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  },
  relative(iso) {
    if (!iso) return '';
    const diff = (new Date(iso) - Date.now()) / 1000;
    // English like the rest of the interface; dates keep the browser's locale.
    const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    const abs = Math.abs(diff);
    if (abs < 45) return diff < 0 ? 'just now' : 'in a moment';
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

// Drawers: create and set-up forms slide in from the right over the list
// they add to, so the list stays in view (UniFi style).
function openDrawer(id, focus) {
  const d = $(id);
  if (!d.open) d.showModal();
  (focus || d.querySelector('input:not([type=hidden]):not([type=radio]):not([type=checkbox]), select'))?.focus();
}
const closeDrawer = (id) => $(id).open && $(id).close();
document.addEventListener('click', (e) => {
  const d = e.target.closest('dialog.drawer');
  if (!d) return;
  if (e.target === d || e.target.closest('[data-close]')) d.close();
});

const emptyRow = (cols, ...content) => el('tr', {}, el('td', { class: 'empty-state', colspan: cols }, ...content));
const emptyItem = (...content) => el('li', { class: 'empty-state' }, ...content);

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

// In sidebar order: Dashboard, Console, Players; Manage (world, backups,
// server, automation); Monitor (insights); then rconsole's own settings.
// Servers isn't in the sidebar: the server switcher at the top leads there.
const AREAS = {
  dashboard: { name: 'Dashboard', icon: 'dashboard' },
  console: { name: 'Console', icon: 'console' },
  players: { name: 'Players', icon: 'players' },
  world: { name: 'World', icon: 'worlds' },
  backups: { name: 'Backups', icon: 'backups' },
  server: { name: 'Server', icon: 'server' },
  automation: { name: 'Automation', icon: 'schedule' },
  insights: { name: 'Insights', icon: 'insights' },
  settings: { name: 'Settings', icon: 'settings' },
  servers: { name: 'Servers', icon: 'server', hidden: true },
  noaccess: { name: 'No access', icon: 'key', hidden: true },
};
// Roles: what the signed-in account may do. The server enforces it; the UI
// hides what would only fail. Mirrors MODERATOR_COMMANDS in server.js.
// myRole is the role on the server rconsole shows (it can differ per
// server); myGlobalRole, the account's own, covers rconsole's settings.
let myRole = 'admin';
let myGlobalRole = 'admin';
const ROLE_RANK = { none: -1, viewer: 0, moderator: 1, admin: 2 };
const atLeast = (role) => ROLE_RANK[myRole] >= ROLE_RANK[role];
const globalAtLeast = (role) => ROLE_RANK[myGlobalRole] >= ROLE_RANK[role];
const allowedHere = (node) => (!node.dataset.minRole || atLeast(node.dataset.minRole)) && (!node.dataset.minGlobalRole || globalAtLeast(node.dataset.minGlobalRole));
const MOD_COMMANDS = new Set(['say', 'me', 'tell', 'msg', 'w', 'tellraw', 'list', 'tps', 'mspt', 'help', 'kick', 'ban', 'ban-ip', 'pardon', 'pardon-ip', 'banlist', 'whitelist', 'tp', 'teleport', 'gamemode', 'spectate', 'mute', 'unmute', 'tempban', 'tempmute', 'warn', 'unban']);
const roleForCommand = (cmd) => {
  const name = String(cmd).trim().split(/\s+/)[0].toLowerCase().replace(/^[a-z0-9_.-]+:/, '');
  return MOD_COMMANDS.has(name) && !/^whitelist\s+(on|off|reload)\b/i.test(cmd) ? 'moderator' : 'admin';
};
function applyRole(role, globalRole = role) {
  myRole = ROLE_RANK[role] != null ? role : 'admin';
  myGlobalRole = ROLE_RANK[globalRole] != null && globalRole !== 'none' ? globalRole : 'admin';
  document.body.dataset.role = myRole;
  document.body.dataset.globalRole = myGlobalRole;
  // Forms that change things are read-only below their role.
  for (const id of ['settings-form', 'task-form', 'world-new', 'world-import']) if ($(id)) $(id).inert = !atLeast('admin');
  for (const id of ['notify-form', 'os-form', 'server-new', 'sys-web', 'sys-security', 'sys-backups']) if ($(id)) $(id).inert = !globalAtLeast('admin');
  if (!atLeast('admin') || !globalAtLeast('admin')) showTab(location.hash.slice(1)); // falls back from views this role can't open
}

// On phones the tab bar shows these four; the rest live under "More".
const PHONE_TABS = ['dashboard', 'console', 'players', 'server'];
// Old bookmarks and links in notifications keep working (4.3 layout).
const ALIASES = {
  worlds: 'world/worlds',
  map: 'world/map',
  schedule: 'automation',
  updates: 'server/updates',
  notifications: 'settings/notifications',
  'server/settings': 'server/properties', // renamed: it edits server.properties
  'server/configs': 'server/files',
  'server/servers': 'servers',
  account: 'settings/account',
  'settings/about': 'settings/system',
  'settings/backups': 'backups',
  'players/access': 'players/people',
  'players/history': 'players/people',
  'players/security': 'players/addresses',
  'players/chat': 'console/chat',
  'insights/audit': 'insights/activity',
  'insights/problems': 'dashboard/problems',
};
const tabLoaders = {};
const viewLoaders = {};

function currentView(area) {
  return document.querySelector(`#tab-${area} .subnav [aria-selected=true]`)?.dataset.view || null;
}

function showView(area, view) {
  const section = $(`tab-${area}`);
  const tabs = [...(section?.querySelectorAll('.subnav [role=tab]') || [])].filter(allowedHere);
  if (!tabs.length) return;
  if (!tabs.some((t) => t.dataset.view === view)) view = tabs[0].dataset.view;
  for (const t of tabs) t.setAttribute('aria-selected', t.dataset.view === view);
  for (const v of section.querySelectorAll(':scope > .view')) v.hidden = v.dataset.view !== view;
  viewLoaders[`${area}/${view}`]?.();
}

function showTab(route) {
  route = ALIASES[route] || route || '';
  let [name, view] = route.split('/');
  if (!AREAS[name] || (name === 'noaccess' && myRole !== 'none')) name = 'dashboard';
  // Without a role on the shown server only Settings and the server list are left.
  if (myRole === 'none' && !['settings', 'servers'].includes(name)) name = 'noaccess';
  // Views that are a mode of an area rather than a sub-page.
  if (name === 'console' && view === 'chat') setLogView('chat');
  if (view === 'problems') {
    view = undefined;
    setTimeout(openProblems, 0);
  }
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
  $('nav-more').classList.toggle('on', !PHONE_TABS.includes(name));
  closeSwitcher();
  for (const d of document.querySelectorAll('dialog.drawer[open]')) d.close();
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

// "[12:00:00] [Server thread/INFO]: message": time and source dimmed, so the
// message itself stands out; plugin prefixes like [Essentials] get a tag.
const LINE_RE = /^(\[[^\]]{5,25}\]) (\[[^\]]{1,80}\]):? ?(.*)$/s;
function lineContent(text) {
  const m = text.match(LINE_RE);
  if (!m) return [text];
  const [, time, source, rest] = m;
  const level = source.match(/\/(INFO|WARN|ERROR|FATAL|DEBUG)\]$/)?.[1] || '';
  const plugin = rest.match(/^\[([A-Za-z0-9_.-]{2,40})\] /);
  return [
    el('span', { class: 'l-time' }, time), ' ',
    el('span', { class: `l-src${level ? ` l-${level.toLowerCase()}` : ''}` }, source), ' ',
    plugin ? [el('span', { class: 'l-tag' }, plugin[1]), ' ', rest.slice(plugin[0].length)] : rest,
  ];
}

function addLine(text, cls = classify(text)) {
  log.querySelector('.log-empty')?.remove();
  const div = el('div', { class: cls }, ...(cls === 'cmd' || cls.startsWith('reply') || cls === 'sys' ? [text] : lineContent(text)));
  div.hidden = !visible(div);
  log.append(div);
  while (log.childElementCount > MAX_LINES) log.firstElementChild.remove();
  scrollLog();
}

function refilter() {
  for (const div of log.children) if (!div.classList.contains('log-empty')) div.hidden = !visible(div);
  scrollLog(true);
}

$('filter').addEventListener('input', () => (view === 'chat' ? renderChat() : refilter()));
// All output: the log and the command line. Chat: players' messages, joins
// and leaves, with a box to write to everyone or whisper to one player.
function setLogView(v) {
  view = v === 'chat' ? 'chat' : 'all';
  for (const r of $('log-view').children) r.setAttribute('aria-checked', String(r.dataset.view === view));
  const chat = view === 'chat';
  log.hidden = chat;
  $('chat-list').hidden = !chat;
  $('form').hidden = chat;
  $('chat-form').hidden = !chat;
  $('follow').hidden = chat;
  $('clear-log').hidden = chat;
  $('filter').placeholder = chat ? 'Filter chat' : 'Filter log';
  if (chat) {
    fillChatTargets();
    renderChat.done = false;
    renderChat();
  } else refilter();
}
$('log-view').addEventListener('click', (e) => {
  const b = e.target.closest('[role=radio]');
  if (b) setLogView(b.dataset.view);
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
    resetChat(lines);
  });
  source.addEventListener('line', (e) => {
    const line = JSON.parse(e.data);
    addLine(line);
    pushChat(line);
  });
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

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const cmd = $('cmd').value.trim();
  if (!cmd) return;
  closeSuggestions();
  $('cmd-hint').hidden = true;
  const name = cmd.replace(/^\//, '').split(' ')[0].toLowerCase();
  if (COMMANDS[name]?.danger && !(await confirmAction({
    title: `Run /${name}?`,
    body: `${COMMANDS[name].d}. Players get no warning. Server → Power stops or restarts with a countdown instead.`,
    confirm: `Run /${name}`, tone: 'danger', icon: 'stop',
  }))) return;
  history_.push(cmd);
  histPos = history_.length;
  $('cmd').value = '';
  setFollowing(true);
  run(cmd.replace(/^\//, ''));
});

// ---------------------------------------------------------------------------
// Command autocomplete: catalog (commands.js) merged with what the server
// reports, argument completions from live lists.
// ---------------------------------------------------------------------------

let serverCommands = null;
let serverCommandsLoading = null;
let accessCache = null;
let catalogCache = null;

function loadServerCommands(refresh) {
  if (serverCommandsLoading) return serverCommandsLoading;
  serverCommandsLoading = api('GET', `/api/commands${refresh ? '?refresh' : ''}`)
    .then((r) => { serverCommands = r.commands; catalogCache = null; })
    .catch(() => {})
    .finally(() => (serverCommandsLoading = null));
  return serverCommandsLoading;
}

function ensureAccess() {
  if (!accessCache) api('GET', '/api/access').then((a) => (accessCache = a)).catch(() => {});
}

// Splits a grammar string at top-level spaces.
function splitTop(str, sep = ' ') {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if ('([<'.includes(ch)) depth++;
    if (')]>'.includes(ch)) depth--;
    if (ch === sep && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function parseSlot(tok) {
  let optional = false;
  if (/^\[.*\]$/.test(tok)) {
    optional = true;
    tok = tok.slice(1, -1);
  }
  if (/^\(.*\)$/.test(tok)) return { kind: 'choice', optional, text: tok, options: splitTop(tok.slice(1, -1), '|').map((o) => o.trim().split(' ')[0]).filter((o) => o && !o.startsWith('<')) };
  if (/^<.*>$/.test(tok)) return { kind: 'arg', optional, text: tok, name: tok.slice(1, -1) };
  if (tok === '…' || tok === '...') return { kind: 'rest', optional: true, text: '…' };
  return { kind: 'literal', optional, text: tok, value: tok };
}

const GREEDY = /^(message|reason|text|action|command)$/i;

function argType(name) {
  const n = name.toLowerCase();
  if (['player', 'target', 'victim'].includes(n)) return 'player';
  if (['players', 'targets', 'entity', 'entities', 'destination'].includes(n)) return 'players';
  if (n === 'rule') return 'gamerule';
  if (n === 'value') return 'bool';
  return n;
}

function argValues(name) {
  const t = argType(name);
  const online = lastStatus?.game?.players?.players || [];
  if (t === 'player') return online;
  if (t === 'players') return [...online, ...ARG_VALUES.selector];
  if (t === 'whitelisted') return (accessCache?.whitelist || []).map((p) => p.name);
  if (t === 'banned') return (accessCache?.bans || []).map((p) => p.name);
  if (t === 'bannedip') return (accessCache?.ipBans || []).map((p) => p.ip);
  if (t === 'op') return (accessCache?.ops || []).map((p) => p.name);
  return ARG_VALUES[t] || [];
}

function commandCatalog() {
  if (catalogCache) return catalogCache;
  const map = new Map();
  const onServer = serverCommands ? new Map(serverCommands.map((c) => [c.name, c])) : null;
  for (const [name, c] of Object.entries(COMMANDS)) {
    const target = c.alias ? COMMANDS[c.alias] : c;
    map.set(name, { name, description: c.d, forms: (target.f || ['']).map((f) => splitTop(f).map(parseSlot)), syntax: target.f || [''], alias: c.alias || null, danger: Boolean(c.danger), known: !onServer || onServer.has(name) });
  }
  for (const c of serverCommands || []) {
    if (map.has(c.name)) {
      if (!map.get(c.name).description && c.description) map.get(c.name).description = c.description;
      continue;
    }
    const syntax = c.usage.length ? c.usage : [''];
    map.set(c.name, { name: c.name, description: c.description || 'Server command', forms: syntax.map((f) => splitTop(f).map(parseSlot)), syntax, plugin: true, known: true });
  }
  catalogCache = map;
  return map;
}

// Tokens of the command line; the last one is the word being typed.
function lineTokens(value) {
  const v = value.replace(/^\//, '');
  const parts = v.split(' ');
  return parts;
}

function matchingForms(cmd, args) {
  return cmd.forms.map((form, fi) => ({ form, fi })).filter(({ form }) => {
    for (let i = 0; i < args.length; i++) {
      const slot = form[i];
      if (!slot) return form.some((sl) => sl.kind === 'rest' || (sl.kind === 'arg' && GREEDY.test(sl.name)));
      if (slot.kind === 'rest' || (slot.kind === 'arg' && GREEDY.test(slot.name))) return true;
      const a = args[i].toLowerCase();
      if (slot.kind === 'literal' && slot.value.toLowerCase() !== a) return false;
      if (slot.kind === 'choice' && slot.options.length && !slot.options.some((o) => o.toLowerCase() === a)) return false;
    }
    return true;
  });
}

function rankByPrefix(values, word, key = (v) => v) {
  const w = word.toLowerCase();
  const pre = values.filter((v) => key(v).toLowerCase().startsWith(w));
  const sub = w ? values.filter((v) => !key(v).toLowerCase().startsWith(w) && key(v).toLowerCase().includes(w)) : [];
  return [...pre, ...sub];
}

// { items: [{ label, insert, detail, desc, danger }], hint: { cmd, form, slot } }
function suggest(value) {
  const tokens = lineTokens(value);
  const cat = commandCatalog();
  if (tokens.length === 1) {
    const word = tokens[0];
    if (!word) return { items: [], hint: null };
    const all = [...cat.values()];
    let ranked = rankByPrefix(all, word, (c) => c.name);
    if (word.length > 2) {
      const w = word.toLowerCase();
      ranked = [...ranked, ...all.filter((c) => !ranked.includes(c) && (c.description || '').toLowerCase().includes(w))];
    }
    ranked.sort((a, b) => (b.known - a.known) || (a.name.toLowerCase().startsWith(word.toLowerCase()) ? 0 : 1) - (b.name.toLowerCase().startsWith(word.toLowerCase()) ? 0 : 1));
    const exact = cat.get(word.toLowerCase());
    return {
      items: ranked.slice(0, 12).map((c) => ({ label: `/${c.name}`, insert: c.name, detail: c.syntax[0] || '', desc: c.alias ? `Alias of /${c.alias}` : c.description, danger: c.danger, muted: !c.known })),
      hint: exact ? { cmd: exact, form: exact.forms[0], slot: -1 } : null,
    };
  }
  const cmd = cat.get(tokens[0].toLowerCase());
  if (!cmd) return { items: [], hint: null };
  const args = tokens.slice(1, -1);
  const word = tokens[tokens.length - 1];
  const forms = matchingForms(cmd, args);
  const k = args.length;
  const values = [];
  const details = new Map();
  for (const { form } of forms) {
    const slot = form[k];
    if (!slot) continue;
    const add = (v, d) => {
      if (!values.includes(v)) {
        values.push(v);
        details.set(v, d);
      }
    };
    if (slot.kind === 'literal') add(slot.value, 'subcommand');
    else if (slot.kind === 'choice') slot.options.forEach((o) => add(o, 'subcommand'));
    else if (slot.kind === 'arg') argValues(slot.name).forEach((v) => add(v, slot.name));
  }
  const w = word.toLowerCase();
  const slotMatches = (slot) => slot && ((slot.kind === 'literal' && slot.value.toLowerCase().startsWith(w)) || (slot.kind === 'choice' && slot.options.some((o) => o.toLowerCase().startsWith(w))));
  const hintForm = (w && forms.find(({ form }) => slotMatches(form[k]))?.form) || forms[0]?.form || cmd.forms[0];
  return {
    items: rankByPrefix(values, word).slice(0, 12).map((v) => ({ label: v, insert: v, detail: details.get(v), desc: '' })),
    hint: { cmd, form: hintForm, slot: k },
  };
}

const cmdInput = $('cmd');
const suggestBox = $('cmd-suggest');
const hintBox = $('cmd-hint');
let suggestions = [];
let activeSuggestion = -1;
let navigated = false;

function renderHint(h) {
  hintBox.hidden = !h;
  if (!h) return;
  const parts = [el('b', {}, `/${h.cmd.name}`)];
  h.form.forEach((slot, i) => parts.push(' ', el('span', { class: `slot${i === h.slot ? ' on' : ''}${slot.optional ? ' opt' : ''}` }, slot.optional && slot.kind !== 'rest' ? `[${slot.text}]` : slot.text)));
  const more = h.cmd.forms.length > 1 ? el('span', { class: 'note' }, ` +${h.cmd.forms.length - 1} more form${h.cmd.forms.length > 2 ? 's' : ''}`) : null;
  hintBox.replaceChildren(el('span', { class: 'sig' }, ...parts, more),
    h.cmd.description ? el('span', { class: 'desc' }, h.cmd.danger ? icon('alert') : null, h.cmd.alias ? `Alias of /${h.cmd.alias}` : h.cmd.description) : null);
  hintBox.classList.toggle('danger', h.cmd.danger);
}

function renderSuggestions() {
  suggestBox.hidden = !suggestions.length;
  cmdInput.setAttribute('aria-expanded', String(suggestions.length > 0));
  suggestBox.replaceChildren(...suggestions.map((sg, i) => el('li', {
    id: `sg-${i}`, role: 'option', 'aria-selected': String(i === activeSuggestion), class: sg.muted ? 'muted' : null,
    onmousedown: (e) => { e.preventDefault(); acceptSuggestion(i); },
  }, el('span', { class: 'sg-label' }, sg.label), sg.detail ? el('span', { class: 'sg-detail' }, sg.detail) : null, sg.desc ? el('span', { class: 'sg-desc' }, sg.desc) : null)));
  if (activeSuggestion >= 0) cmdInput.setAttribute('aria-activedescendant', `sg-${activeSuggestion}`);
  else cmdInput.removeAttribute('aria-activedescendant');
  suggestBox.querySelector('[aria-selected=true]')?.scrollIntoView({ block: 'nearest' });
}

function updateSuggestions() {
  const r = suggest(cmdInput.value);
  const tokens = lineTokens(cmdInput.value);
  const word = tokens[tokens.length - 1];
  // Don't offer exactly what is already typed as the only option.
  suggestions = r.items.length === 1 && r.items[0].insert.toLowerCase() === word.toLowerCase() ? [] : r.items;
  activeSuggestion = -1;
  navigated = false;
  renderSuggestions();
  renderHint(r.hint);
}

function closeSuggestions() {
  suggestions = [];
  activeSuggestion = -1;
  renderSuggestions();
}

function acceptSuggestion(i) {
  const sg = suggestions[i];
  if (!sg) return;
  const tokens = lineTokens(cmdInput.value);
  tokens[tokens.length - 1] = sg.insert;
  cmdInput.value = `${tokens.join(' ')} `;
  cmdInput.focus();
  updateSuggestions();
}

cmdInput.setAttribute('role', 'combobox');
cmdInput.setAttribute('aria-autocomplete', 'list');
cmdInput.setAttribute('aria-controls', 'cmd-suggest');
cmdInput.setAttribute('aria-expanded', 'false');
cmdInput.addEventListener('focus', () => {
  if (!serverCommands) loadServerCommands().then(() => document.activeElement === cmdInput && updateSuggestions());
  ensureAccess();
});
cmdInput.addEventListener('input', updateSuggestions);
cmdInput.addEventListener('blur', () => setTimeout(() => {
  if (document.activeElement !== cmdInput) {
    closeSuggestions();
    hintBox.hidden = true;
  }
}, 100));

cmdInput.addEventListener('keydown', (e) => {
  const open = suggestions.length > 0;
  if (e.key === ' ' && e.ctrlKey) {
    e.preventDefault();
    updateSuggestions();
    if (!suggestions.length && !cmdInput.value) {
      suggestions = [...commandCatalog().values()].filter((c) => c.known).slice(0, 40).map((c) => ({ label: `/${c.name}`, insert: c.name, detail: c.syntax[0] || '', desc: c.description }));
      renderSuggestions();
    }
    return;
  }
  if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const n = suggestions.length;
    activeSuggestion = e.key === 'ArrowDown' ? (activeSuggestion + 1) % n : (activeSuggestion - 1 + n) % n;
    navigated = true;
    renderSuggestions();
    return;
  }
  if (open && e.key === 'Tab') {
    e.preventDefault();
    acceptSuggestion(Math.max(0, activeSuggestion));
    return;
  }
  if (open && e.key === 'Enter' && navigated && activeSuggestion >= 0) {
    e.preventDefault();
    acceptSuggestion(activeSuggestion);
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (open) closeSuggestions();
    else cmdInput.blur();
    return;
  }
  if (e.key === 'ArrowUp' && histPos > 0) cmdInput.value = history_[--histPos];
  else if (e.key === 'ArrowDown') {
    histPos = Math.min(history_.length, histPos + 1);
    cmdInput.value = history_[histPos] || '';
  } else return;
  e.preventDefault();
  closeSuggestions();
  renderHint(suggest(cmdInput.value).hint);
});

// Quick actions: four built in, plus commands each admin pins in this
// browser (Add → a label and a command).
const QUICK_KEY = 'rconsole.quick';
const savedQuick = () => {
  try {
    return JSON.parse(localStorage.getItem(QUICK_KEY) || '[]').filter((q) => q && typeof q.c === 'string' && typeof q.label === 'string').slice(0, 12);
  } catch {
    return [];
  }
};
function renderQuick() {
  $('quick').querySelectorAll('.pinned').forEach((n) => n.remove());
  for (const [i, q] of savedQuick().entries()) {
    const b = el('button', { class: 'btn pinned', 'data-c': q.c, title: `/${q.c}` }, icon('pin'), el('span', {}, q.label),
      el('span', { class: 'unpin', role: 'button', tabindex: 0, 'aria-label': `Remove ${q.label}`, title: 'Remove', onclick: (e) => {
        e.stopPropagation();
        const list = savedQuick();
        list.splice(i, 1);
        try { localStorage.setItem(QUICK_KEY, JSON.stringify(list)); } catch {}
        renderQuick();
      } }, '×'));
    $('quick').append(b);
  }
}
$('quick').addEventListener('click', (e) => {
  const b = e.target.closest('[data-c]');
  if (b && !e.target.closest('.unpin')) busy(b, () => run(b.dataset.c));
});
$('quick-edit').addEventListener('click', async () => {
  const label = el('input', { class: 'field', maxlength: 24, placeholder: 'e.g. Spawn' });
  const cmd = el('input', { class: 'field mono', maxlength: 200, placeholder: 'e.g. tp @a 0 80 0', spellcheck: 'false' });
  if (!(await confirmAction({ title: 'Add a quick action', body: 'A button that runs this command. It is kept in this browser.', confirm: 'Add', icon: 'pin',
    content: el('div', { class: 'dialog-form' }, fld('Label', label), fld('Command', cmd)) }))) return;
  const c = cmd.value.trim().replace(/^\//, '');
  if (!c) return;
  const list = [...savedQuick(), { label: label.value.trim() || c.split(' ')[0], c }];
  try { localStorage.setItem(QUICK_KEY, JSON.stringify(list)); } catch {}
  renderQuick();
});
renderQuick();

// ---------------------------------------------------------------------------
// Health, online players, restart countdown
// ---------------------------------------------------------------------------

let countdownEnd = null;

// Nominal readouts stay neutral; only off-nominal ones are marked, so the
// strip never borrows an area's colour.
// Memory: for a server rconsole runs, the Java heap really in use (live
// data after the last garbage collection, from its GC log) out of its -Xmx.
// The JVM reserves its whole heap up front, so the host's "used" mostly
// says how much was given to Minecraft, not how much it needs.
function renderMemory(s) {
  const { host, heap } = s;
  const hostUsed = host.mem.total - host.mem.available;
  const hostLine = `Host: ${fmt.bytes(hostUsed)} of ${fmt.bytes(host.mem.total)} used, ${fmt.bytes(host.mem.available)} available.`;
  $('s-mem-label').textContent = heap?.used != null ? 'Java heap' : 'Memory';
  if (heap?.used != null) {
    const share = heap.used / heap.max;
    readout('s-mem', [fmt.bytes(heap.used), el('small', {}, ` / ${fmt.bytes(heap.max)}`)], level(share, 0.75, 0.9));
    $('s-mem').parentElement.title = [
      `${fmt.bytes(heap.used)} of the ${fmt.bytes(heap.max)} heap hold live data (after the last garbage collection, ${fmt.relative(heap.at)}).`,
      `It had grown to ${fmt.bytes(heap.before)} before that collection; the most seen recently: ${fmt.bytes(heap.peak)}.`,
      hostLine,
    ].join('\n');
    return;
  }
  readout('s-mem', [fmt.bytes(hostUsed), el('small', {}, ` / ${fmt.bytes(host.mem.total)}`)], level(hostUsed / host.mem.total, 0.8, 0.92));
  $('s-mem').parentElement.title = heap ? `${hostLine}\nThe Java heap shows here after the server's first garbage collection.` : hostLine;
}

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
  if (chatVisible()) fillChatTargets();
  const { game, host, rcon, power = {} } = s;
  const conn = $('conn');
  const stopped = power.available && power.active !== 'active';
  conn.dataset.state = rcon.ok ? 'ok' : 'down';
  $('status').textContent = rcon.ok ? 'Online' : stopped ? `Server ${POWER_LABEL[power.active]?.toLowerCase() || power.active}` : 'RCON offline';
  conn.title = rcon.ok ? 'Server running, RCON connected' : rcon.error || '';
  $('maint-badge').hidden = !s.maintenance?.enabled;
  renderPlatform(s.platform);
  renderPower(s);
  renderOp(s.op);

  if (game?.tps != null) {
    readout('s-tps', [game.tps.toFixed(1), game.mspt != null ? el('small', {}, ` ${game.mspt.toFixed(1)} ms`) : ''], game.tps >= 19 ? 'good' : game.tps >= 15 ? 'meh' : 'bad');
  } else readout('s-tps', game ? 'n/a' : '–');
  readout('s-players', game?.players ? [String(game.players.online), el('small', {}, ` / ${game.players.max}`)] : '–');
  readout('s-time', game?.daytime != null ? [fmt.gameTime(game.daytime), game.day != null ? el('small', {}, ` day ${game.day}`) : ''] : '–');
  readout('s-cpu', host.cpu != null ? fmt.pct(host.cpu) : '–', host.cpu != null ? level(host.cpu, 0.7, 0.9) : '');
  renderMemory(s);
  if (host.disk) readout('s-disk', fmt.bytes(host.disk.available), level(1 - host.disk.available / host.disk.total, 0.8, 0.92));
  readout('s-uptime', fmt.duration(host.uptime));

  const players = game?.players?.players || [];
  $('count').textContent = game?.players ? `${game.players.online} / ${game.players.max}` : '';
  $('online').replaceChildren(
    ...(players.length
      ? players.map((name) =>
          el('li', { title: `Insert ${name} into the command line`, onclick: () => insertName(name) },
            avatar(name), el('span', { class: 'who-cell' }, el('span', { class: 'name' }, name)),
            el('button', { class: 'btn btn-quiet btn-sm', title: `${name}'s profile`, onclick: (e) => { e.stopPropagation(); openPlayer(name); } }, 'Profile')))
      : [emptyItem(rcon.ok ? 'Nobody is online right now.' : 'Player list unavailable while RCON is offline.')])
  );

  const remaining = s.restart?.remaining;
  countdownEnd = remaining != null ? Date.now() + remaining * 1000 : null;
  countdownVerb = s.restart?.verb || 'restarting';
  tickCountdown();

  renderBackupState(s.backup);
  renderUpdateState(s.update);
  renderSelfSummary(s.self);
  if (s.joinRequests !== undefined && s.joinRequests !== joinPending) {
    joinPending = s.joinRequests;
    if (document.body.dataset.area === 'players' && atLeast('moderator')) loadJoin();
  }
  if (!(document.body.dataset.area === 'players' && currentView('players') === 'addresses')) renderSecurityBadge(s.security);
  renderProblemsBadge(s.problems);
  renderSwitcher();
  if (document.body.dataset.area === 'dashboard') renderDashboardTiles();
}

// ---------------------------------------------------------------------------
// Dashboard: the shown server at a glance (header, metric cards, health
// strip from /api/status), its history, the other servers, and what is
// coming up or went wrong. The rest loads when the dashboard opens.
// ---------------------------------------------------------------------------

let dashBackups = null;
let dashUpdates = null;
let dashMetrics = null;
let dashMetric = 'tps';
let dashRange = '6h';
try {
  dashMetric = localStorage.getItem('rconsole.dashMetric') || dashMetric;
  dashRange = localStorage.getItem('rconsole.dashRange') || dashRange;
} catch {}

// Short relative time for narrow columns: "4m", "3h", "2d" ("in 3h" ahead).
// past: the event has happened; a time ahead of this browser's clock (a
// server clock that ran fast, a slightly different clock) reads "now".
function shortAgo(iso, { past = false } = {}) {
  let diff = Date.parse(iso) - Date.now();
  if (past) diff = Math.min(diff, 0);
  const abs = Math.abs(diff) / 1000;
  const v = abs < 60 ? 'now' : abs < 3600 ? `${Math.round(abs / 60)}m` : abs < 86400 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`;
  return v === 'now' ? v : diff > 0 ? `in ${v}` : v;
}

// A small line of real samples, no axes: the shape of the last hours.
function sparkline(values, { max, min = 0, label }) {
  const W = 120, H = 32;
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'spark', role: 'img', 'aria-label': label });
  if (pts.length < 2) return svg;
  const hi = max ?? Math.max(...pts.map(([, v]) => v), 1);
  const x = (i) => (i / (values.length - 1)) * W;
  const y = (v) => H - 2 - ((Math.min(v, hi) - min) / (hi - min || 1)) * (H - 4);
  // One line and one filled area per stretch without gaps.
  let d = '';
  let fill = '';
  let seg = [];
  const flush = () => {
    if (seg.length > 1) fill += `M${seg[0][0]},${H}L${seg.map((p) => p.join(',')).join('L')}L${seg[seg.length - 1][0]},${H}Z`;
    seg = [];
  };
  let prev = -2;
  for (const [i, v] of pts) {
    if (i !== prev + 1) flush();
    const p = [x(i).toFixed(1), y(v).toFixed(1)];
    d += `${i === prev + 1 ? 'L' : 'M'}${p.join(',')}`;
    seg.push(p);
    prev = i;
  }
  flush();
  svg.append(svgEl('path', { d: fill, class: 'spark-fill' }), svgEl('path', { d, class: 'spark-line' }));
  return svg;
}

// The metrics the cards show and the big chart can switch to.
const DASH_METRICS = {
  tps: { label: 'TPS', icon: 'insights' },
  players: { label: 'Players', icon: 'players' },
  cpu: { label: 'CPU', icon: 'server' },
  mem: { label: 'Memory', icon: 'save' },
};

function renderDashHero(s) {
  const p = s.power || {};
  const running = s.rcon?.ok;
  const shown = serversList.find((x) => x.id === serversActive);
  const state = p.available ? p.active : running ? 'active' : 'inactive';
  $('dh-state').dataset.state = s.maintenance?.enabled ? 'maint' : state === 'active' && running ? 'ok' : state === 'failed' ? 'bad' : state === 'activating' || state === 'deactivating' ? 'busy' : 'off';
  $('dh-name').textContent = shown?.name || s.platform?.name || 'Minecraft';
  const label = p.available ? POWER_LABEL[p.active] || p.active : running ? 'Running' : 'Offline';
  const facts = [
    el('b', {}, s.maintenance?.enabled ? `${label} · maintenance` : label),
    running && p.since && Date.parse(p.since) < Date.now() ? `for ${fmt.relative(p.since).replace(/ ago$/, '')}` : p.active === 'failed' && p.result ? p.result : null,
    [s.platform?.name, s.platform?.mcVersion, s.platform?.build ? `#${s.platform.build}` : null].filter(Boolean).join(' ') || null,
    shown ? `port ${shown.port}` : null,
    s.game?.daytime != null && running ? `${s.game.day != null ? `day ${s.game.day}, ` : 'in-game '}${fmt.gameTime(s.game.daytime)}` : null,
  ].filter(Boolean);
  $('dh-facts').replaceChildren(...facts.flatMap((f, i) => (i ? [el('span', { class: 'dh-dotsep', 'aria-hidden': 'true' }, '·'), f] : [f])));
  const busyNow = Boolean(p.pending) || s.op?.running || s.restart?.remaining != null;
  const can = p.available;
  $('dh-start').hidden = !can || p.active === 'active';
  $('dh-restart').hidden = can && p.active !== 'active';
  $('dh-stop').hidden = can && p.active !== 'active';
  for (const id of ['dh-start', 'dh-restart', 'dh-stop']) $(id).disabled = !can || busyNow;
  $('dh-save').disabled = !running;
  $('dh-backup').disabled = Boolean(s.backup?.running);
  const banner = s.restart?.remaining != null ? `${s.restart.verb === 'stopping' ? 'Stopping' : 'Restarting'} in ${fmt.countdown(s.restart.remaining)}. Players are being warned in chat.`
    : s.op?.running ? `${s.op.label}: ${s.op.step}…`
      : s.backup?.running ? 'Backup running…'
        : null;
  $('dh-banner').hidden = !banner;
  $('dh-banner').textContent = banner || '';
}

function renderDashCards() {
  const s = lastStatus;
  if (!s) return;
  const g = s.game || {};
  const m = dashMetrics;
  const running = s.rcon?.ok;
  const heap = s.heap?.used != null && s.heap.max ? s.heap : null;
  const pcpu = m ? lastOf(m.pcpu) : null;
  const range = { '1h': 'hour', '6h': '6 hours', '24h': '24 hours', '7d': '7 days' }[dashRange];
  const tps = m ? nums(m.tps) : [];
  const players = m ? nums(m.players) : [];
  const cards = {
    tps: {
      value: g.tps != null ? g.tps.toFixed(1) : '–', unit: g.tps != null ? 'TPS' : '',
      tone: g.tps == null ? '' : g.tps >= 19 ? 'good' : g.tps >= 15 ? 'warn' : 'bad',
      sub: running ? [g.mspt != null ? `${g.mspt.toFixed(1)} ms/tick` : null, tps.length ? `low ${Math.min(...tps).toFixed(1)} in ${range}` : null].filter(Boolean).join(' · ') || null : 'Server not running',
      spark: m && sparkline(m.tps, { max: 20, label: `TPS, last ${range}` }),
    },
    players: {
      value: g.players ? String(g.players.online) : '–', unit: g.players ? `/ ${g.players.max}` : '',
      sub: players.length ? `peak ${Math.max(...players)} in ${range}` : running ? 'Nobody online' : 'Server not running',
      spark: m && sparkline(m.players, { max: Math.max(4, ...players), label: `Players online, last ${range}` }),
    },
    cpu: {
      value: pcpu != null ? fmt.pct(pcpu) : s.host?.cpu != null ? fmt.pct(s.host.cpu) : '–', unit: pcpu != null ? 'Minecraft' : 'host',
      tone: pcpu != null ? level(pcpu, 0.7, 0.9).replace('meh', 'warn').replace('good', '') : '',
      sub: s.host?.cpu != null ? `host ${fmt.pct(s.host.cpu)}${s.host.cores ? ` of ${s.host.cores} cores` : ''}` : null,
      spark: m && sparkline(m.pcpu.some((v) => v != null) ? m.pcpu : m.cpu, { max: 1, label: `CPU, last ${range}` }),
    },
    mem: {
      value: heap ? fmt.bytes(heap.used) : s.host?.mem ? fmt.bytes(s.host.mem.total - s.host.mem.available) : '–', unit: heap ? 'heap' : 'used',
      tone: s.host?.mem?.available < 300 * 2 ** 20 ? 'warn' : heap ? level(heap.used / heap.max, 0.75, 0.9).replace('meh', 'warn').replace('good', '') : '',
      sub: heap ? `of ${fmt.bytes(heap.max)} · host ${fmt.bytes(s.host.mem.available)} free` : s.host?.mem ? `of ${fmt.bytes(s.host.mem.total)}` : null,
      spark: m && sparkline((m.heap || []).some((v) => v != null) ? m.heap : m.mem, { max: 1, label: `Memory, last ${range}` }),
    },
  };
  $('dash-cards').replaceChildren(...Object.entries(DASH_METRICS).map(([key, def]) => {
    const c = cards[key];
    return el('button', { class: `dash-card ${c.tone || ''}`, type: 'button', 'aria-pressed': String(key === dashMetric), onclick: () => pickDashMetric(key) },
      el('span', { class: 'dc-label' }, icon(def.icon), def.label),
      el('span', { class: 'dc-value' }, el('b', {}, c.value), c.unit ? el('small', {}, c.unit) : null),
      c.spark || el('span', { class: 'spark' }),
      c.sub ? el('span', { class: 'dc-sub' }, c.sub) : null);
  }));
}

function healthItem({ label, value, sub, tone = '', href, onclick, icon: iconName, meter: ratio }) {
  const body = [
    el('span', { class: 'dh-ico' }, icon(iconName)),
    el('span', { class: 'dh-body' },
      el('span', { class: 'dh-label' }, label),
      el('b', { class: 'dh-value' }, value),
      sub ? el('span', { class: 'dh-sub' }, sub) : null,
      ratio != null ? meter(ratio, 1, '') : null),
  ];
  const cls = `dash-health-item ${tone}`;
  return href ? el('a', { class: cls, href }, ...body) : onclick ? el('button', { class: cls, type: 'button', onclick }, ...body) : el('div', { class: cls }, ...body);
}

function renderDashHealth() {
  const s = lastStatus;
  if (!s) return;
  const b = dashBackups;
  const lastBackup = b?.files?.[0];
  const backupAge = lastBackup ? Date.now() - Date.parse(lastBackup.created) : null;
  const prob = s.problems || {};
  const selfNew = s.self?.available || 0;
  const disk = s.host?.disk;
  const used = disk ? 1 - disk.available / disk.total : null;
  $('dash-health').replaceChildren(
    healthItem({ label: 'Last backup', icon: 'backups', href: '#backups',
      value: s.backup?.running ? 'Running…' : lastBackup ? fmt.relative(lastBackup.created) : b ? 'None yet' : '–',
      sub: s.backup?.lastError ? 'The last backup failed' : lastBackup ? `${lastBackup.world}, ${fmt.bytes(lastBackup.size)}` : b ? 'Schedule one under Automation' : null,
      tone: s.backup?.lastError || (b && !lastBackup) ? 'bad' : backupAge > 2 * 86400000 ? 'warn' : lastBackup ? 'good' : '' }),
    healthItem({ label: 'Problems', icon: 'alert', onclick: openProblems,
      value: prob.unseen ? `${prob.unseen} new` : 'All clear', tone: prob.critical ? 'bad' : prob.unseen ? 'warn' : 'good',
      sub: prob.critical ? `${prob.critical} critical` : prob.unseen ? 'Errors in the last 24 hours' : 'Nothing new in 24 hours' }),
    healthItem({ label: 'Updates', icon: 'updates', href: '#server/updates',
      value: dashUpdates?.server ? 'Available' : selfNew ? 'rconsole' : 'Up to date', tone: dashUpdates?.server || selfNew ? 'info' : 'good',
      sub: [dashUpdates?.server ? `${s.platform?.name || 'Server'} ${dashUpdates.server}` : null, selfNew ? `rconsole: ${selfNew} new change${selfNew === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || `${s.platform?.name || ''} ${s.platform?.mcVersion || ''}${s.platform?.build ? ` #${s.platform.build}` : ''}`.trim() }),
    healthItem({ label: 'Disk', icon: 'save', value: disk ? `${fmt.bytes(disk.available)} free` : '–', meter: used,
      tone: disk ? level(used, 0.8, 0.92).replace('meh', 'warn') : '',
      sub: disk ? `of ${fmt.bytes(disk.total)} · host up ${fmt.duration(s.host.uptime)}` : null }),
  );
}

function renderDashOnline() {
  const s = lastStatus;
  if (!s) return;
  const g = s.game || {};
  const online = g.players?.players || [];
  $('dash-count').textContent = g.players ? `${g.players.online} / ${g.players.max}` : '';
  $('dash-online').replaceChildren(...(online.length
    ? online.map((name) => el('li', { class: 'clickable', onclick: () => openPlayer(name) }, avatar(name), el('span', { class: 'who-cell' }, el('span', { class: 'name' }, name)), el('span', { class: 'meta' }, 'Profile')))
    : [emptyItem(s.rcon?.ok ? 'Nobody is online right now.' : 'The player list shows when the server runs.')]));
}

// Every status poll (5 s): what /api/status alone answers.
function renderDashboardTiles() {
  if (!lastStatus) return;
  renderDashHero(lastStatus);
  renderDashCards();
  renderDashHealth();
  renderDashOnline();
}

// The big chart: one metric, the range picked above it.
function renderDashChart() {
  const m = dashMetrics;
  if (!m) return;
  const base = { t: m.t, from: m.from, to: m.to, step: m.step, up: m.up, height: 220 };
  const pct = (v) => fmt.pct(v);
  const stat = (label, v) => el('div', {}, el('dt', {}, label), el('dd', {}, v));
  const box = $('dash-chart');
  box.querySelector('.legend')?.remove(); // the series change with the metric
  let stats = [];
  if (dashMetric === 'tps') {
    const tps = nums(m.tps);
    const mspt = nums(m.mspt);
    lineChart(box, { ...base, label: 'TPS', max: 20, yFmt: (v) => String(Math.round(v)), series: [{ values: m.tps, label: 'TPS', fmt: (v) => v.toFixed(1) }, ...(mspt.length ? [{ values: m.mspt, label: 'MSPT', fmt: (v) => `${v.toFixed(1)} ms`, tipOnly: true }] : [])] });
    // Paper's tps command reports no tick time; then there is no MSPT to show.
    stats = [['Avg TPS', avg(tps)?.toFixed(1) ?? '–'], ['Low', tps.length ? Math.min(...tps).toFixed(1) : '–'], ...(mspt.length ? [['Avg MSPT', `${avg(mspt).toFixed(1)} ms`], ['Worst', `${Math.max(...mspt).toFixed(1)} ms`]] : [])];
  } else if (dashMetric === 'players') {
    const pl = nums(m.players);
    lineChart(box, { ...base, label: 'Players online', minMax: 4, yFmt: (v) => (Number.isInteger(v) ? String(v) : ''), series: [{ values: m.players, label: 'Players', fmt: String }] });
    stats = [['Now', lastOf(m.players) ?? '–'], ['Peak', pl.length ? Math.max(...pl) : '–'], ['Avg', pl.length ? avg(pl).toFixed(1) : '–']];
  } else if (dashMetric === 'cpu') {
    const pc = nums(m.pcpu);
    lineChart(box, { ...base, label: 'CPU', max: 1, yFmt: pct, series: [{ values: m.pcpu, label: 'Minecraft', fmt: pct }, { values: m.cpu, label: 'Host', fmt: pct, cls: 'alt' }] });
    stats = [['Minecraft avg', pc.length ? pct(avg(pc)) : '–'], ['Peak', pc.length ? pct(Math.max(...pc)) : '–'], ['Host now', lastOf(m.cpu) != null ? pct(lastOf(m.cpu)) : '–']];
  } else {
    const heap = (m.heap || []).some((v) => v != null);
    const h = nums(m.heap || []);
    lineChart(box, { ...base, label: 'Memory', max: 1, yFmt: pct, series: [
      ...(heap ? [{ values: m.heap, label: 'Java heap in use', fmt: pct }] : []),
      { values: m.mem, label: 'Host used', fmt: pct, cls: heap ? 'alt' : '' },
    ] });
    stats = [...(heap ? [['Heap avg', h.length ? pct(avg(h)) : '–'], ['Heap peak', h.length ? pct(Math.max(...h)) : '–']] : []), ['Host now', lastOf(m.mem) != null ? pct(lastOf(m.mem)) : '–'], ['Minecraft RSS', lastOf(m.rss) != null ? fmt.bytes(lastOf(m.rss)) : '–']];
  }
  $('dash-stats').replaceChildren(...stats.map(([l, v]) => stat(l, String(v))));
  const down = m.up.filter((v) => v === 0).length;
  $('dash-perf-title').textContent = { tps: 'Performance', players: 'Players online', cpu: 'CPU', mem: 'Memory' }[dashMetric];
  $('dash-chart-note').textContent = !m.t.length ? 'Collecting; the first points arrive within 30 seconds.'
    : down ? `Shaded: server down (${fmt.duration((down * m.step))}).` : `${m.step === 30 ? '30-second samples' : '5-minute averages'}, no downtime.`;
}

function pickDashMetric(key) {
  dashMetric = key;
  try { localStorage.setItem('rconsole.dashMetric', key); } catch {}
  renderDashCards();
  renderDashChart();
}

$('dash-range').addEventListener('click', (e) => {
  const b = e.target.closest('[data-range]');
  if (!b) return;
  dashRange = b.dataset.range;
  try { localStorage.setItem('rconsole.dashRange', dashRange); } catch {}
  for (const x of $('dash-range').querySelectorAll('[data-range]')) x.setAttribute('aria-checked', String(x === b));
  loadDashMetrics();
});
for (const x of $('dash-range').querySelectorAll('[data-range]')) x.setAttribute('aria-checked', String(x.dataset.range === dashRange));

async function loadDashMetrics() {
  try {
    dashMetrics = await api('GET', `/api/metrics?range=${dashRange}`);
    renderDashChart();
    renderDashCards();
  } catch (e) {
    $('dash-chart-note').textContent = `Can't load metrics: ${e.message}`;
  }
}

// Every server rconsole installed, with what it does right now.
function renderDashServers(list) {
  const panel = $('dash-servers-panel');
  panel.hidden = list.length < 2 && !(serversAttached && list.length);
  if (panel.hidden) return;
  const rank = (s) => (s.id === serversActive ? 0 : s.state?.active === 'active' ? 1 : 2);
  const sorted = [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const running = list.filter((s) => s.state?.active === 'active');
  const playing = running.reduce((n, s) => n + (s.live?.players?.online || 0), 0);
  $('dash-servers-note').textContent = `${running.length} of ${list.length} running${playing ? ` · ${playing} player${playing === 1 ? '' : 's'} in total` : ''}.`;
  $('dash-servers').replaceChildren(...sorted.map((s) => {
    const live = s.live || {};
    const on = s.state?.active === 'active';
    const memMax = s.memoryMb * 2 ** 20;
    const software = s.kind === 'proxy' ? 'Velocity proxy' : `${s.distribution[0].toUpperCase()}${s.distribution.slice(1)} ${s.version}`;
    const admin = (s.myRole || myRole) === 'admin';
    return el('li', { class: `dash-server${s.id === serversActive ? ' shown' : ''}` },
      el('span', { class: 'sw-dot', 'data-state': on ? 'ok' : s.state?.active === 'failed' ? 'bad' : 'off' }),
      el('span', { class: 'ds-name' }, el('b', {}, s.name), s.id === serversActive ? el('span', { class: 'pill own' }, 'Shown') : null, el('span', { class: 'sub' }, `${software} · port ${s.port}`)),
      el('span', { class: 'ds-stat', title: live.players?.sample?.length ? live.players.sample.join(', ') : null },
        el('small', {}, s.kind === 'proxy' ? 'Connected' : 'Players'), on && live.players ? `${live.players.online} / ${live.players.max}` : '–'),
      el('span', { class: 'ds-stat' }, el('small', {}, 'CPU'), on && live.cpu != null ? fmt.pct(live.cpu) : '–'),
      el('span', { class: 'ds-stat ds-mem' }, el('small', {}, 'Memory'), on && live.rss != null ? `${fmt.bytes(live.rss)}` : '–',
        Object.assign(meter(on && live.rss != null ? live.rss : 0, memMax, ''), { title: `of ${fmt.bytes(memMax)} set` })),
      el('span', { class: 'ds-act' },
        admin && !on && s.state?.available ? serverButton('Start', 'play', (b) => serverAction(s, 'start', b).then(loadDashServers)) : null,
        s.id !== serversActive && s.kind === 'server' ? serverButton('Show', 'server', (b) => showServer(s, b)) : null));
  }));
}

async function loadDashServers() {
  try {
    const r = await api('GET', '/api/servers?live');
    serversList = r.servers;
    serversActive = r.active;
    serversAttached = r.attached;
    renderDashServers(r.servers);
    renderSwitcher();
    if (lastStatus) renderDashHero(lastStatus);
  } catch {
    $('dash-servers-panel').hidden = true;
  }
}

function dashItem({ time, title, main, sub, tone = '', onclick, href }) {
  const body = [el('time', { title: title || null }, time), el('span', { class: 'dl-main' }, main, sub ? el('span', { class: 'sub' }, sub) : null)];
  const cls = `dash-li ${tone}`;
  if (href) return el('li', {}, el('a', { class: cls, href }, ...body));
  if (onclick) return el('li', {}, el('button', { class: cls, type: 'button', onclick }, ...body));
  return el('li', { class: cls }, ...body);
}

async function loadDashUpcoming() {
  try {
    const { tasks, servers, shown } = await api('GET', '/api/tasks');
    const name = (id) => (id === null ? null : servers.find((x) => x.id === id)?.name || id);
    const many = servers.length > 1;
    const next = tasks.filter((t) => t.enabled && t.nextRun).sort((a, b) => a.nextRun.localeCompare(b.nextRun)).slice(0, 5);
    const events = tasks.filter((t) => t.enabled && t.trigger.type === 'event').length;
    $('dash-upcoming').replaceChildren(...(next.length
      ? next.map((t) => dashItem({ time: shortAgo(t.nextRun), title: fmt.date(t.nextRun), href: '#automation', tone: t.running ? 'run' : '',
          main: t.name || t.steps.map((st) => st.type[0].toUpperCase() + st.type.slice(1).replace(/-/g, ' ')).join(' → '),
          sub: [fmt.date(t.nextRun), many && t.server !== shown ? name(t.server) : null, /^error/i.test(t.lastResult || '') ? 'last run failed' : null].filter(Boolean).join(' · ') }))
      : [emptyItem(tasks.length ? 'Nothing scheduled.' : 'No tasks yet. Schedule backups and restarts under Automation.')]),
      ...(events ? [el('li', { class: 'dash-li-foot' }, `${events} more run${events === 1 ? 's' : ''} on events.`)] : []));
  } catch (e) {
    $('dash-upcoming').replaceChildren(emptyItem(`Can't load tasks: ${e.message}`));
  }
}

async function loadDashProblems() {
  try {
    const { groups } = await api('GET', '/api/problems?days=7');
    const top = groups.slice(0, 4);
    $('dash-problems-count').textContent = groups.length ? String(groups.length) : '';
    $('dash-problems').replaceChildren(...(top.length
      ? top.map((x) => dashItem({ time: shortAgo(new Date(x.last).toISOString(), { past: true }), title: fmt.date(new Date(x.last).toISOString()), onclick: openProblems,
          tone: x.severity === 'critical' || x.severity === 'error' ? 'bad' : 'warn',
          main: problemTitle(x), sub: [x.count > 1 ? `${x.count}×` : null, x.plugin, x.unseen ? 'new' : null].filter(Boolean).join(' · ') || null }))
      : [emptyItem('No errors or warnings in the last 7 days.')]));
  } catch (e) {
    $('dash-problems').replaceChildren(emptyItem(`Can't scan the logs: ${e.message}`));
  }
}
$('dash-problems-all').addEventListener('click', openProblems);

function renderDashBackups() {
  const b = dashBackups;
  if (!b) return;
  const files = b.files || [];
  const total = files.reduce((n, f) => n + f.size, 0);
  $('dash-backups-note').textContent = files.length ? `${files.length} kept, ${fmt.bytes(total)}${b.keep ? ` · keeps the newest ${b.keep}` : ''}.` : 'None yet.';
  // Sizes of the last backups, oldest left: growth or a broken one shows.
  const recent = files.slice(0, 14).reverse();
  const max = Math.max(...recent.map((f) => f.size), 1);
  $('dash-backup-bars').replaceChildren(...recent.map((f) => {
    const bar = el('span', { title: `${fmt.date(f.created)}: ${fmt.bytes(f.size)}` });
    bar.style.height = `${Math.max(6, Math.round((f.size / max) * 100))}%`; // CSSOM: the CSP allows no style attributes
    return bar;
  }));
  $('dash-backup-bars').hidden = recent.length < 3;
  $('dash-backups').replaceChildren(...(files.length
    ? files.slice(0, 4).map((f) => dashItem({ time: shortAgo(f.created, { past: true }), title: fmt.date(f.created), href: '#backups', main: f.world, sub: `${fmt.bytes(f.size)} · ${fmt.date(f.created)}` }))
    : [emptyItem('No backups yet. Press Back up now, or schedule one under Automation.')]));
}

function activityItem(when, who, what, detail, bad) {
  return el('li', { class: bad ? 'bad' : '' }, el('time', { title: fmt.date(when) }, shortAgo(when, { past: true })), el('span', {}, el('b', {}, who), ` ${what}`, detail ? el('span', { class: 'sub' }, ` ${detail}`) : null));
}

// Below admin there is no audit log to show: joins and leaves from the log.
function renderJoins() {
  if (globalAtLeast('admin')) return;
  $('dash-activity-title').textContent = 'Joins and leaves';
  const ev = chatEvents.filter((e) => e.kind === 'join' || e.kind === 'leave').slice(-8).reverse();
  $('dash-activity').replaceChildren(...(ev.length
    ? ev.map((e) => el('li', {}, el('time', {}, e.time), el('span', {}, el('b', {}, e.name), e.kind === 'join' ? ' joined' : ' left')))
    : [el('li', { class: 'empty' }, 'Nobody joined or left since the log started.')]));
}

async function dashPower(action) {
  const name = $('dh-name').textContent;
  let seconds = 0;
  if (action !== 'start') {
    const delay = delaySelect(60);
    if (!(await confirmAction({
      title: `${action === 'stop' ? 'Stop' : 'Restart'} ${name}?`,
      body: action === 'stop' ? 'Players are warned, the world is saved and the server stays off until you start it.' : 'Players are warned, the world is saved and the server comes straight back.',
      confirm: action === 'stop' ? 'Stop server' : 'Restart server', tone: action === 'stop' ? 'danger' : 'primary', icon: action === 'stop' ? 'stop' : 'restart',
      content: fld(action === 'stop' ? 'Stop' : 'Restart', delay),
    }))) return;
    seconds = Number(delay.value);
  }
  await startOp('/api/server/power', { action, seconds });
}
$('dh-start').addEventListener('click', (e) => busy(e.currentTarget, () => dashPower('start')));
$('dh-restart').addEventListener('click', (e) => busy(e.currentTarget, () => dashPower('restart')));
$('dh-stop').addEventListener('click', (e) => busy(e.currentTarget, () => dashPower('stop')));
$('dh-backup').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  try {
    renderBackupState((await api('POST', '/api/backups', {})).state);
    toast('Backup started.');
    refreshStatus(true);
  } catch (err) {
    toast(err.message, 'bad');
  }
}));
$('dh-save').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  try {
    const { output } = await api('POST', '/api/command', { command: 'save-all' });
    toast(output ? output.split('\n')[0].slice(0, 120) : 'World saved.');
  } catch (err) {
    toast(err.message, 'bad');
  }
}));

async function loadDashboard() {
  renderDashboardTiles();
  const jobs = [
    api('GET', '/api/backups').then((b) => { dashBackups = b; renderDashHealth(); renderDashBackups(); }).catch(() => {}),
    api('GET', '/api/updates').then((u) => {
      const b = u.newerBuilds?.[0];
      dashUpdates = { server: b ? `#${b.id}` : u.newerVersions?.length ? u.newerVersions[0] : null };
      renderDashHealth();
    }).catch(() => {}),
    loadDashMetrics(),
    loadDashServers(),
    loadDashUpcoming(),
    loadDashProblems(),
  ];
  // Daily activity needs the player history (moderators and admins).
  $('ph-daily').closest('.panel').hidden = !atLeast('moderator');
  if (atLeast('moderator')) {
    jobs.push(api('GET', '/api/players/history').then((h) => {
      historyData = h;
      const now = Date.now();
      const span = h.daily.length && now - Date.parse(h.daily[0].day) < 14 * 86400000 ? 14 : 30; // little history: two weeks
      const days = [];
      for (let i = span - 1; i >= 0; i--) {
        const d = new Date(now - i * 86400000);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const found = h.daily.find((x) => x.day === key);
        days.push({ value: (found?.playtime || 0) / 3600000, players: found?.players || 0, label: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), title: d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) });
      }
      barChart($('ph-daily'), days, { label: 'Hours played per day', fmt: (v) => (v >= 1 || v === 0 ? `${+v.toFixed(1)}h` : `${Math.round(v * 60)}m`), detail: (b) => [`${b.value.toFixed(1)} hours played`, `${b.players} player${b.players === 1 ? '' : 's'}`] });
    }).catch(() => {}));
  }
  // Recent activity: who changed what (admins), or joins and leaves.
  if (globalAtLeast('admin')) {
    $('dash-activity-title').textContent = 'Recent activity';
    jobs.push(api('GET', '/api/audit?limit=8').then((r) => {
      $('dash-activity').replaceChildren(...(r.entries.length
        ? r.entries.slice(0, 8).map((e) => activityItem(e.at, e.user || '–', e.action, e.target, !e.ok))
        : [el('li', { class: 'empty' }, 'Nothing yet. Changes and sign-ins show up here.')]));
    }).catch(() => {}));
  } else renderJoins();
  await Promise.all(jobs);
}
tabLoaders.dashboard = loadDashboard;
// Metrics and the server list every 30 s (samples arrive that often), the rest every minute.
let dashTick = 0;
setInterval(() => {
  if (document.hidden || document.body.dataset.area !== 'dashboard') return;
  if (++dashTick % 2) {
    loadDashMetrics();
    loadDashServers();
  } else loadDashboard();
}, 30000);

// Server software: chip in the top bar; Plugins/Mods tab follows what it loads.
let platformKey = '';
function renderPlatform(pf) {
  if (!pf) return;
  const key = `${pf.id}|${pf.mcVersion}|${pf.build}|${pf.addons}`;
  if (key === platformKey) return;
  platformKey = key;
  const chip = $('platform-chip');
  chip.hidden = false;
  chip.dataset.family = pf.family;
  chip.replaceChildren(icon('server'), el('b', {}, pf.name), pf.mcVersion ? el('span', {}, pf.mcVersion) : '', pf.build ? el('small', {}, `#${pf.build}`) : '');
  chip.title = [`${pf.name}${pf.mcVersion ? ` on Minecraft ${pf.mcVersion}` : ''}`, pf.build ? `build ${pf.build}` : null, pf.loaderVersion ? `loader ${pf.loaderVersion}` : null,
    pf.addons ? `loads ${pf.addons}s` : 'no plugins or mods', pf.updates ? 'updated by rconsole' : 'updated by hand'].filter(Boolean).join(' · ');
  const tab = document.querySelector('#tab-server .subnav [data-view=plugins]');
  tab.hidden = !pf.addons;
  tab.textContent = pf.addons === 'mod' ? 'Mods' : 'Plugins';
  const kind = pf.addons === 'mod' ? 'mod' : 'plugin';
  $('plugins-title').textContent = `Installed ${kind}s`;
  $('plugin-search').elements.q.placeholder = kind === 'mod' ? 'Search mods, e.g. lithium' : 'Search plugins, e.g. squaremap';
  $('modrinth-note').textContent = pf.family === 'bukkit'
    ? `${kind[0].toUpperCase()}${kind.slice(1)}s that run on ${pf.name}, those for your Minecraft version first; older ones are marked and usually work too. Downloads are checked against Modrinth's SHA-512.`
    : `Only ${kind}s for your Minecraft version that run on ${pf.name} are offered. Downloads are checked against Modrinth's SHA-512.`;
  if (!pf.addons && currentView('server') === 'plugins') showView('server', 'overview');
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

// --- Server → Overview: what this server is, at a glance ---
async function loadServerSummary() {
  const row = (k, v) => el('div', {}, el('dt', {}, k), el('dd', {}, v));
  const sub = (v) => el('span', { class: 'sub' }, v);
  try {
    const s = await api('GET', '/api/server/summary');
    const pf = s.platform || {};
    const players = s.players || lastStatus?.game?.players;
    const running = s.state.available ? s.state.active === 'active' : Boolean(lastStatus?.rcon?.ok);
    $('srv-title').textContent = `${pf.name || 'Minecraft'}${pf.mcVersion ? ` ${pf.mcVersion}` : ''}`;
    $('srv-note').textContent = running
      ? `Running${s.state.since ? ` since ${fmt.date(s.state.since)} (${fmt.relative(s.state.since)})` : ''}.`
      : 'Stopped.';
    $('srv-facts').replaceChildren(
      row('Software', [pf.name || '–', pf.build ? sub(` build ${pf.build}`) : null, pf.loaderVersion ? sub(` · loader ${pf.loaderVersion}`) : null]),
      row('World', el('a', { href: '#world/worlds' }, s.world)),
      row('Port', String(s.port)),
      row('Players', players ? `${players.online} of ${players.max} online` : s.maxPlayers ? `up to ${s.maxPlayers}` : '–'),
      row('Access', [s.whitelist ? 'Whitelist on' : 'Anyone can join', sub(s.onlineMode ? ' · online mode' : ' · offline mode')]),
      row('Gameplay', [s.difficulty ? s.difficulty[0].toUpperCase() + s.difficulty.slice(1) : '–', s.gamemode ? sub(` · ${s.gamemode}`) : null]),
      row('Memory', lastStatus?.heap?.used != null
        ? [fmt.bytes(lastStatus.heap.used), sub(` in use of a ${fmt.bytes(lastStatus.heap.max)} heap`)]
        : s.process?.rss ? fmt.bytes(s.process.rss) : sub('–')),
      row(pf.addons === 'mod' ? 'Mods' : 'Plugins', pf.addons ? el('a', { href: '#server/plugins' }, 'Manage') : sub('None')),
      row('Message of the day', s.motd ? s.motd.replace(/§./g, '') : sub('–')));
  } catch (e) {
    $('srv-note').textContent = e.message;
  }
}
viewLoaders['server/overview'] = loadServerSummary;

// --- Server → Servers: servers rconsole installs and runs itself ---
const VERIFY_NOTE = { sha256: 'SHA-256 from the publisher', sha1: 'SHA-1 from Mojang', md5: 'MD5 only (all Purpur publishes)', 'sha256-maven': 'SHA-256 from its Maven' };
const DIST_NOTE = {
  vanilla: 'Mojang’s own server', paper: 'Fast, plugins', folia: 'Paper on many threads', purpur: 'Paper with more options',
  fabric: 'Lightweight mods', quilt: 'Fabric-compatible mods', forge: 'Classic mod loader', neoforge: 'Modern Forge mods', velocity: 'Proxy for several servers',
  modpack: 'From Modrinth, ready to play',
};
let serversOpRunning = false;
let serversTimer;
let distLoaded = false;

function renderServersOp(op) {
  const box = $('servers-op');
  const recent = op && !op.running && op.finishedAt && Date.now() - Date.parse(op.finishedAt) < 60000;
  box.hidden = !op || (!op.running && !recent);
  if (!box.hidden) {
    box.dataset.state = op.running ? 'running' : op.error ? 'failed' : 'done';
    box.textContent = op.running ? `${op.label}: ${op.step}…` : op.error ? `${op.label} failed: ${op.error}` : `${op.label}: done.`;
  }
  if (serversOpRunning && op && !op.running) toast(op.error ? `${op.label} failed: ${op.error}` : `${op.label}: done.`, op.error ? 'bad' : 'ok');
  serversOpRunning = Boolean(op?.running);
  document.querySelectorAll('#server-new [data-op], #server-list button').forEach((b) => (b.disabled = serversOpRunning));
}

function serverButton(label, iconName, fn, danger) {
  const btn = el('button', { class: `btn btn-quiet btn-sm${danger ? ' danger' : ''}`, disabled: serversOpRunning || undefined }, icon(iconName), label);
  btn.addEventListener('click', () => fn(btn));
  return btn;
}

function serverStateLabel(s) {
  if (!s.state.available) return el('span', { class: 'pill bad', title: s.state.error || '' }, 'Not controllable');
  const active = s.state.active;
  const loop = active === 'failed' && s.state.result === 'start-limit-hit';
  return el('span', { class: `pill ${active === 'active' ? 'ok' : active === 'failed' ? 'bad' : ''}`, title: loop ? 'It crashed 5 times in 10 minutes and was left stopped. Check the log, then press Start.' : null },
    active === 'active' ? 'Running' : active === 'activating' ? 'Starting' : active === 'deactivating' ? 'Stopping' : loop ? 'Crashed repeatedly' : active === 'failed' ? 'Crashed' : 'Stopped');
}

async function serverAction(s, action, button) {
  if (action !== 'start' && !(await confirmAction({
    title: `${action === 'stop' ? 'Stop' : 'Restart'} ${s.name}?`,
    body: 'Players are disconnected; the world is saved first.',
    confirm: action === 'stop' ? 'Stop' : 'Restart', tone: action === 'stop' ? 'danger' : 'primary', icon: action === 'stop' ? 'stop' : 'restart',
  }))) return;
  await busy(button, async () => {
    try {
      renderServersOp(await api('POST', `/api/servers/${s.id}/power`, { action }));
      watchServers();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
}

async function deleteServer(s, button) {
  const keep = el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: true }), ' Keep an archive in the backup folder');
  if (!(await confirmAction({
    title: `Delete ${s.name}?`,
    body: `The server stops and its folder is removed: worlds, plugins, mods and settings.${s.id === serversActive ? ' It is the server rconsole shows; another one takes its place.' : ''}`,
    confirm: 'Delete server', tone: 'danger', icon: 'delete', content: keep,
  }))) return;
  const archive = keep.querySelector('input').checked;
  await busy(button, async () => {
    try {
      renderServersOp(await api('DELETE', `/api/servers/${s.id}${archive ? '' : '?archive=0'}`));
      watchServers();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
}

async function showServer(s, button) {
  if (!(await confirmAction({
    title: `Show ${s.name} in rconsole?`,
    body: `Console, players, worlds, backups, plugins and updates switch to ${s.name}. rconsole restarts for a moment; ${serversActive ? `${serversActive}` : 'the server it shows now'} keeps running.`,
    confirm: 'Show', tone: 'primary', icon: 'server',
  }))) return;
  await busy(button, async () => {
    try {
      await api('POST', `/api/servers/${s.id}/show`);
      toast(`Switching to ${s.name}. The page reloads when rconsole is back.`);
      waitForComeback();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
}

// Memory, Java tuning, autostart and port lock of an installed server.
async function serverSettings(s, button) {
  const memory = el('select', { class: 'field', name: 'memoryMb' },
    ...[512, 1024, 2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768].concat(s.memoryMb).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b)
      .map((mb) => option(String(mb), fmt.bytes(mb * 1048576))));
  memory.value = String(s.memoryMb);
  const flags = el('select', { class: 'field', name: 'flags' },
    option('aikar', "Aikar's flags (recommended)"), option('zgc', 'Generational ZGC (Java 21+, 12 GB and more)'), option('default', 'Java defaults (G1)'));
  flags.value = s.flags;
  const autostart = el('input', { type: 'checkbox', checked: s.autostart || undefined });
  const lock = el('input', { type: 'checkbox', checked: s.portLock || undefined });
  const extra = el('input', { class: 'field mono', value: (s.extraPorts || []).join(', '), placeholder: 'e.g. 8100, 24454' });
  const note = el('p', { class: 'note' });
  const extraFld = el('label', { class: 'fld', hidden: !s.portLock || undefined }, el('span', {}, 'Extra ports (maps, voice chat)'), extra);
  lock.addEventListener('change', () => (extraFld.hidden = !lock.checked));
  memory.addEventListener('change', () => memoryNote(note, memory, s.id));
  const content = el('div', { class: 'dialog-form' },
    el('label', { class: 'fld' }, el('span', {}, 'Memory'), memory), note,
    el('label', { class: 'fld' }, el('span', {}, 'Java tuning'), flags),
    el('label', { class: 'check' }, autostart, ' Start after a reboot'),
    el('label', { class: 'check' }, lock, ' Lock network ports (game, RCON and the extra ports only)'),
    extraFld);
  memoryNote(note, memory, s.id);
  memory.value = String(s.memoryMb);
  if (!(await confirmAction({ title: `Settings of ${s.name}`, body: 'Changes apply at the next start.', confirm: 'Save', tone: 'primary', icon: 'settings', content }))) return;
  const body = { memoryMb: Number(memory.value), flags: flags.value, autostart: autostart.checked, portLock: lock.checked, extraPorts: lock.checked ? parsePorts(extra.value) : [] };
  await busy(button, async () => {
    try {
      const op = await sendServerRequest('PATCH', `/api/servers/${s.id}`, body, 'Save anyway?');
      if (!op) return;
      renderServersOp(op);
      watchServers();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
}

let serversActive = null;
let serversMemTotalMb = null;
let serversList = [];
let lastServersOp = null;
let serversAttached = false;
let serversUsedPorts = new Set();
const freePort = (from) => {
  let p = from;
  while (serversUsedPorts.has(p)) p++;
  return p;
};
async function loadServers() {
  try {
    const { servers, active, attached, usedPorts, distributions, op, dir, memTotalMb } = await api('GET', '/api/servers');
    serversUsedPorts = new Set(usedPorts || []);
    serversMemTotalMb = memTotalMb || null;
    serversList = servers;
    serversActive = active;
    serversAttached = attached;
    if (!distLoaded) renderDistributions(distributions);
    renderServerFormExtras();
    const names = Object.fromEntries(distributions.map((d) => [d.id, d.name]));
    $('servers-info').replaceChildren(
      servers.length
        ? `${servers.length} server${servers.length === 1 ? '' : 's'}${active ? `, showing ${active}` : attached ? ', showing the server rconsole is attached to until you press Show' : ''}.`
        : 'No server yet. rconsole downloads it with the right Java and checks every file.',
      el('span', { class: 'servers-dir mono', title: dir }, dir));
    // The shown server first, then game servers, then proxies, by name.
    const rank = (s) => (s.id === active ? 0 : s.kind === 'server' ? 1 : 2);
    servers.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    $('server-list').replaceChildren(...(servers.length
      ? servers.map((s) => el('tr', {},
          el('td', { class: 'primary-cell', 'data-label': 'Server' },
            el('span', { class: 'srv-name' }, el('b', {}, s.name), s.id === active ? el('span', { class: 'pill own' }, 'Shown') : null, s.kind === 'proxy' ? el('span', { class: 'pill' }, 'Proxy') : null),
            s.name !== s.id ? el('span', { class: 'sub mono' }, s.id) : null),
          el('td', { class: 'nowrap', 'data-label': 'Software' }, s.modpack ? el('span', { title: `Modpack ${s.modpack.name} ${s.modpack.version}, ${s.modpack.files} files` }, `${s.modpack.name} ${s.modpack.version}`) : null, s.modpack ? el('span', { class: 'sub' }, `${names[s.distribution] || s.distribution} ${s.version}`) : `${names[s.distribution] || s.distribution} ${s.version}`, s.build ? el('span', { class: 'sub' }, typeof s.build === 'number' ? `build ${s.build}` : `loader ${s.build}`) : null),
          el('td', { class: 'mono num', 'data-label': 'Port' }, String(s.port)),
          el('td', { class: 'nowrap', 'data-label': 'Memory' }, fmt.bytes(s.memoryMb * 1024 * 1024), el('span', { class: 'sub' }, `Java ${s.java}${s.flags === 'zgc' ? ', ZGC' : ''}${s.portLock ? ', ports locked' : ''}`)),
          el('td', { 'data-label': 'State' }, serverStateLabel(s)),
          el('td', { class: 'act' }, (s.myRole || myRole) === 'admin' ? [
            s.state.active === 'active'
              ? [serverButton('Restart', 'restart', (b) => serverAction(s, 'restart', b)), serverButton('Stop', 'stop', (b) => serverAction(s, 'stop', b))]
              // Starting, or waiting to restart after a crash: Stop ends it.
              : s.state.active === 'activating' ? serverButton('Stop', 'stop', (b) => serverAction(s, 'stop', b))
              : serverButton('Start', 'play', (b) => serverAction(s, 'start', b)),
            s.id !== active && s.kind === 'server' ? serverButton('Show', 'server', (b) => showServer(s, b)) : null,
            serverButton('Settings', 'settings', (b) => serverSettings(s, b)),
            serverButton('Delete', 'delete', (b) => deleteServer(s, b), true),
          ] : null)))
      : [emptyRow(6, el('b', {}, 'No servers yet. '), globalAtLeast('admin') ? 'Press New server to pick the software and version.' : 'An admin can install one.')]));
    renderServersOp(op);
    lastServersOp = op;
    if (!servers.length && !attached && !op?.running && !op?.result && globalAtLeast('admin') && !$('drawer-server').open && document.body.dataset.area === 'servers') toggleServerForm(true);
    renderSwitcher();
  } catch (e) {
    $('server-list').replaceChildren(emptyRow(6, `Can't list servers: ${e.message}`));
  }
}
tabLoaders.servers = loadServers;

// --- Server switcher (top of the sidebar): which server rconsole shows ---
// The menu's parts are built once and only changed when the list changes:
// replacing a button between mouse-down and mouse-up (the list arriving while
// someone clicks) swallows the click.
let switcherKey = '';
function renderSwitcher() {
  const shown = serversList.find((s) => s.id === serversActive);
  $('sw-name').textContent = shown?.name || (serversAttached || !serversList.length ? lastStatus?.platform?.name || 'Minecraft' : '…');
  const st = lastStatus?.power;
  $('sw-dot').dataset.state = !lastStatus ? '' : lastStatus.rcon?.ok ? 'ok' : st?.active === 'failed' ? 'bad' : 'off';
  const menu = $('switcher-menu');
  if (!menu.firstChild) {
    menu.append(
      el('div', { id: 'sw-list' }),
      el('hr'),
      el('a', { class: 'sw-item', role: 'menuitem', href: '#servers', onclick: () => closeSwitcher() }, icon('server'), el('span', {}, 'Manage servers')),
      el('a', { class: 'sw-item', role: 'menuitem', href: '#servers', 'data-min-global-role': 'admin', onclick: (e) => { e.preventDefault(); closeSwitcher(); showTab('servers'); toggleServerForm(true); } }, icon('add'), el('span', {}, 'New server')));
  }
  const key = JSON.stringify([serversActive, serversAttached, serversList.map((s) => [s.id, s.name, s.kind, s.distribution, s.version, s.port, s.state?.active])]);
  if (key === switcherKey) return;
  switcherKey = key;
  const items = serversList.map((s) => el('button', { class: `sw-item${s.id === serversActive ? ' on' : ''}`, role: 'menuitemradio', 'aria-checked': String(s.id === serversActive),
    onclick: (e) => { if (s.id === serversActive) return closeSwitcher(); closeSwitcher(); showServer(s, e.currentTarget); } },
    el('span', { class: 'sw-dot', 'data-state': s.state?.active === 'active' ? 'ok' : s.state?.active === 'failed' ? 'bad' : 'off' }),
    el('span', { class: 'sw-item-text' }, el('b', {}, s.name), el('span', { class: 'sub' }, `${s.kind === 'proxy' ? 'Velocity proxy' : `${s.distribution[0].toUpperCase()}${s.distribution.slice(1)} ${s.version}`} · port ${s.port}`)),
    s.id === serversActive ? icon('check') : null));
  $('sw-list').replaceChildren(...(items.length ? items : [el('p', { class: 'note sw-empty' }, serversAttached ? 'rconsole is attached to a server it didn’t install.' : 'No servers yet.')]));
}
function closeSwitcher() {
  $('switcher-menu').hidden = true;
  $('switcher-btn').setAttribute('aria-expanded', 'false');
}
$('switcher-btn').addEventListener('click', async () => {
  const open = $('switcher-menu').hidden;
  if (!open) return closeSwitcher();
  renderSwitcher();
  $('switcher-menu').hidden = false;
  $('switcher-btn').setAttribute('aria-expanded', 'true');
  loadServerList().then(renderSwitcher);
});
document.addEventListener('click', (e) => { if (!e.target.closest('#switcher')) closeSwitcher(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('switcher-menu').hidden) { closeSwitcher(); $('switcher-btn').focus(); } });
// The list alone, for the switcher; the Servers page loads the rest.
async function loadServerList() {
  try {
    const r = await api('GET', '/api/servers');
    serversList = r.servers;
    serversActive = r.active;
    serversAttached = r.attached;
    serversMemTotalMb = r.memTotalMb || serversMemTotalMb;
  } catch {}
}

// Polls while an install, start or delete runs. rconsole restarts when the
// first server is installed or the shown one is deleted; the page then
// waits for it and reloads onto the new state.
function watchServers() {
  clearTimeout(serversTimer);
  const shown = serversActive;
  serversTimer = setTimeout(async () => {
    try {
      await loadServers();
    } catch {}
    if (serversOpRunning) return watchServers();
    const op = lastServersOp;
    if (!op || op.error) return;
    const restarts = (!shown && !serversAttached && /^Create server /.test(op.label) && !/\(Velocity /.test(op.label)) || (shown && op.label === `Delete server ${shown}`);
    if (restarts) {
      toast('rconsole is switching servers. The page reloads when it is back.');
      waitForComeback();
    }
  }, 2000);
}

const serverForm = $('server-new');
const PROXY_READY = new Set(['paper', 'folia', 'purpur']);
const parsePorts = (text) => [...new Set(String(text || '').split(/[\s,]+/).filter(Boolean).map(Number))];

// Memory choices that can't fit on this machine are disabled; the note
// says how much the servers already claim.
// What a server with this heap really uses: heap plus Java's own memory
// (as lib/instances.js memoryMaxMb, before the cap).
const javaNeedsMb = (heap) => heap + Math.max(1536, Math.round(heap / 2));
function memoryNote(box, select, exceptId, pickDefault) {
  const total = serversMemTotalMb;
  for (const o of select.options) o.disabled = Boolean(total && Number(o.value) + 512 > total);
  if (select.selectedOptions[0]?.disabled) select.value = [...select.options].reverse().find((o) => !o.disabled)?.value || select.value;
  if (!total) return (box.hidden = true);
  const others = serversList.filter((s) => s.id !== exceptId);
  const claimed = others.reduce((sum, s) => sum + javaNeedsMb(s.memoryMb), 0);
  // A new server starts with the most that still fits next to the others.
  if (pickDefault) {
    const fits = [...select.options].filter((o) => !o.disabled && claimed + javaNeedsMb(Number(o.value)) <= total);
    select.value = (fits.reverse().find((o) => Number(o.value) <= 4096) || select.options[0]).value;
  }
  const over = claimed + javaNeedsMb(Number(select.value)) > total;
  box.hidden = false;
  box.classList.toggle('warn-note', over);
  select.toggleAttribute('aria-invalid', over);
  box.textContent = `This machine has ${fmt.bytes(total * 1048576)} of RAM${others.length ? `; the other servers use about ${fmt.bytes(claimed * 1048576)}` : ''}. Java needs about 1.5 GB more than the heap.${over ? ' This choice doesn\'t fit when all servers run at once.' : ''}`;
}

function renderServerFormExtras() {
  const f = serverForm.elements;
  const keep = f.proxy.value;
  const proxies = serversList.filter((s) => s.kind === 'proxy');
  f.proxy.replaceChildren(option('', 'Directly (no proxy)'), ...proxies.map((p) => option(p.id, `${p.name} (Velocity, port ${p.port})`)));
  f.proxy.value = proxies.some((p) => p.id === keep) ? keep : '';
  updateServerFormKind();
  memoryNote($('server-new-memory'), f.memoryMb);
}

// Fields that only make sense for game servers, or for Paper behind a proxy.
function updateServerFormKind() {
  const f = serverForm.elements;
  // The software choices are radio buttons that exist once the list loaded.
  const d = f.distribution?.value || '';
  const isProxy = d === 'velocity';
  const isPack = d === 'modpack';
  serverForm.querySelectorAll('[data-kind="server"]').forEach((n) => (n.hidden = isProxy));
  serverForm.querySelectorAll('.not-modpack').forEach((n) => (n.hidden = isPack));
  f.version.required = !isPack;
  $('modpack-pick').hidden = !isPack;
  $('server-new-proxy').hidden = !PROXY_READY.has(d) || !serversList.some((s) => s.kind === 'proxy');
  $('server-new-extra').hidden = !f.portLock.checked;
}
serverForm.elements.portLock.addEventListener('change', updateServerFormKind);
serverForm.elements.memoryMb.addEventListener('change', () => memoryNote($('server-new-memory'), serverForm.elements.memoryMb));

// Sends a server request; when the servers together could use more memory
// than the machine has, asks once and sends it again with force.
async function sendServerRequest(method, url, body, what) {
  try {
    return await api(method, url, body);
  } catch (e) {
    if (e.data?.confirm !== 'memory') throw e;
    if (!(await confirmAction({ title: 'Not enough memory for all servers', body: `${e.message} ${what}`, confirm: 'Continue', tone: 'danger', icon: 'alert' }))) return null;
    return api(method, url, { ...body, force: true });
  }
}

function toggleServerForm(open) {
  if (open) {
    if (!distLoaded) loadServers();
    memoryNote($('server-new-memory'), serverForm.elements.memoryMb, undefined, true);
    openDrawer('drawer-server', serverForm.querySelector('.dist-card input'));
  } else closeDrawer('drawer-server');
}
$('server-new-toggle').addEventListener('click', () => toggleServerForm(true));
$('server-new-cancel').addEventListener('click', () => toggleServerForm(false));

function renderDistributions(list) {
  distLoaded = true;
  const pack = { id: 'modpack', name: 'Modpack', kind: 'server', verify: null };
  $('dist-grid').replaceChildren(...[...list, pack].map((d) => el('label', { class: 'dist-card', title: VERIFY_NOTE[d.verify] || '' },
    el('input', { type: 'radio', name: 'distribution', value: d.id, required: true, onchange: () => (d.id === 'modpack' ? openModpacks() : loadVersions(d)) }),
    el('b', {}, d.name),
    el('span', { class: 'note' }, DIST_NOTE[d.id] || (d.kind === 'proxy' ? 'Proxy' : 'Server')))));
}

// --- modpacks: a Modrinth pack picked here; the helper installs it ---
let modpackPick = null; // { project, versions, version }
let modpackSearch;
function openModpacks() {
  const f = serverForm.elements;
  f.port.value = freePort(25565);
  updateServerFormKind();
  $('server-new-note').textContent = 'Modpack: every file is checked against its SHA-512 from Modrinth.';
  // Modpacks need more than plain servers; 6 GB when it fits.
  const six = [...f.memoryMb.options].find((o) => o.value === '6144');
  if (six && !six.disabled && Number(f.memoryMb.value) < 6144) {
    f.memoryMb.value = '6144';
    memoryNote($('server-new-memory'), f.memoryMb);
  }
  if (!$('modpack-hits').childElementCount) searchModpacks();
  $('modpack-q').focus();
}

async function searchModpacks() {
  const q = $('modpack-q').value.trim();
  const box = $('modpack-hits');
  try {
    const { hits } = await api('GET', `/api/distributions/modpacks/search?q=${encodeURIComponent(q)}`);
    if (q !== $('modpack-q').value.trim()) return;
    box.replaceChildren(...(hits.length ? hits.map((h) => el('label', { class: 'modpack-hit' },
      el('input', { type: 'radio', name: 'modpackProject', value: h.id, checked: modpackPick?.project.id === h.id, onchange: () => pickModpack(h) }),
      pluginIcon(h.icon),
      el('b', {}, h.title),
      el('span', { class: 'sub' }, `${h.author} · ${new Intl.NumberFormat(undefined, { notation: 'compact' }).format(h.downloads)} downloads · ${h.description}`))) : [el('p', { class: 'note' }, `No modpacks found for “${q}”.`)]));
  } catch (e) {
    box.replaceChildren(el('p', { class: 'note warn-note' }, `Modrinth can't be reached: ${e.message}`));
  }
}
$('modpack-q').addEventListener('input', () => {
  clearTimeout(modpackSearch);
  modpackSearch = setTimeout(searchModpacks, 300);
});
$('modpack-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(modpackSearch);
    searchModpacks();
  }
});

const LOADER_NAME = { fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge', vanilla: 'Vanilla' };
async function pickModpack(project) {
  const sel = $('modpack-version');
  modpackPick = { project, versions: [], version: null };
  sel.replaceChildren(option('', 'Loading versions…'));
  const f = serverForm.elements;
  const slug = String(project.slug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!f.id.value || f.id.dataset.auto === '1') {
    f.id.value = /^[a-z0-9]/.test(slug) ? slug : 'modpack';
    f.id.dataset.auto = '1';
  }
  try {
    const { versions } = await api('GET', `/api/distributions/modpacks/${encodeURIComponent(project.id)}/versions`);
    if (modpackPick?.project !== project) return;
    modpackPick.versions = versions;
    sel.replaceChildren(...(versions.length
      ? versions.map((v) => option(v.id, `${v.version} · ${LOADER_NAME[v.distribution]} ${v.mc}${v.type !== 'release' ? ` (${v.type})` : ''}`))
      : [option('', 'No server-installable versions')]));
    pickModpackVersion();
  } catch (e) {
    sel.replaceChildren(option('', 'Versions unavailable'));
    toast(e.message, 'bad');
  }
}

function pickModpackVersion() {
  if (!modpackPick) return;
  const v = modpackPick.versions.find((x) => x.id === $('modpack-version').value) || null;
  modpackPick.version = v;
  $('modpack-note').textContent = v
    ? `${modpackPick.project.title} ${v.version} runs on ${LOADER_NAME[v.distribution]} for Minecraft ${v.mc}${v.size ? ` (pack ${fmt.bytes(v.size)}, the mods come on top)` : ''}. rconsole downloads every mod, checks it against the pack's SHA-512 and leaves out client-only ones.`
    : 'rconsole downloads the pack, its mods (each checked against the pack\'s SHA-512), the loader and Java. Mods the pack marks as client-only are left out.';
}
$('modpack-version').addEventListener('change', pickModpackVersion);
serverForm.elements.id.addEventListener('input', () => delete serverForm.elements.id.dataset.auto);

const option = (value, label) => el('option', { value }, label);
async function loadVersions(d) {
  const f = serverForm.elements;
  f.version.replaceChildren(option('', 'Loading versions…'));
  f.build.replaceChildren(option('', 'Newest stable'));
  f.port.value = freePort(d.kind === 'proxy' ? 25577 : 25565);
  if (!f.id.value) f.id.value = d.kind === 'proxy' ? 'proxy' : 'survival';
  updateServerFormKind();
  $('server-new-note').textContent = `${d.name}: ${VERIFY_NOTE[d.verify]}. rconsole downloads the server and the Java it needs and sets up RCON with a random password.`;
  try {
    const { versions } = await api('GET', `/api/distributions/${d.id}/versions`);
    f.version.replaceChildren(...versions.slice(0, 80).map((v) => option(v, v)));
    loadBuilds();
  } catch (e) {
    f.version.replaceChildren(option('', 'Versions unavailable'));
    toast(e.message, 'bad');
  }
}

async function loadBuilds() {
  const f = serverForm.elements;
  const dist = f.distribution.value;
  f.build.replaceChildren(option('', 'Newest stable'));
  if (!dist || !f.version.value || dist === 'vanilla') return;
  try {
    const { builds } = await api('GET', `/api/distributions/${dist}/versions/${encodeURIComponent(f.version.value)}/builds`);
    f.build.append(...builds.map((b) => option(String(b.id), `${typeof b.id === 'number' ? `#${b.id}` : b.id}${b.channel && !/stable|release/i.test(b.channel) ? ` (${b.channel.toLowerCase()})` : ''}`)));
  } catch {}
}
serverForm.elements.version.addEventListener('change', loadBuilds);

serverForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = serverForm.elements;
  if (!f.distribution.value) return toast('Pick the server software.', 'bad');
  const proxy = f.distribution.value === 'velocity';
  const pack = f.distribution.value === 'modpack' ? modpackPick?.version : null;
  if (f.distribution.value === 'modpack' && !pack) return toast('Pick a modpack and its version.', 'bad');
  if (!proxy && !f.eula.checked) return toast('Accept the Minecraft EULA to install a server.', 'bad');
  const buildRaw = f.build.value;
  const body = {
    id: f.id.value.trim(), name: f.id.value.trim(), distribution: pack ? pack.distribution : f.distribution.value, version: pack ? pack.mc : f.version.value,
    build: pack || buildRaw === '' ? null : /^\d+$/.test(buildRaw) && ['paper', 'folia', 'velocity', 'purpur'].includes(f.distribution.value) ? Number(buildRaw) : buildRaw,
    modpack: pack ? { versionId: pack.id, name: modpackPick.project.title } : null,
    port: Number(f.port.value), memoryMb: Number(f.memoryMb.value), flags: f.flags.value,
    start: f.start.checked, autostart: f.autostart.checked, eula: !proxy && f.eula.checked,
    proxy: !proxy && !$('server-new-proxy').hidden ? f.proxy.value || null : null,
    recommended: proxy || f.recommended.checked, owner: proxy ? null : f.owner.value.trim() || null,
    portLock: f.portLock.checked, extraPorts: f.portLock.checked ? parsePorts(f.extraPorts.value) : [],
  };
  await busy(serverForm.querySelector('.btn-primary'), async () => {
    try {
      const op = await sendServerRequest('POST', '/api/servers', body, 'Install it anyway?');
      if (!op) return;
      renderServersOp(op);
      toast(`Installing ${body.id}. ${pack ? 'A modpack takes a few minutes.' : 'This takes a minute or two.'}`);
      serverForm.reset();
      modpackPick = null;
      $('modpack-hits').replaceChildren();
      $('modpack-version').replaceChildren(option('', 'Choose a modpack first'));
      toggleServerForm(false);
      watchServers();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
});

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
    toast(op.error ? `${op.label} failed: ${op.error}` : `${op.label}: done.${op.result?.note ? ` ${op.result.note}` : ''}`, op.error ? 'bad' : 'ok');
    if (document.body.dataset.area === 'world') loadWorlds();
    if (document.body.dataset.area === 'backups') loadBackupsArea();
  }
  opWasRunning = op.running;
  document.querySelectorAll('[data-op]').forEach((b) => (b.disabled = op.running));
}
setInterval(tickCountdown, 1000);

let statusTimer;
async function refreshStatus(soon) {
  clearTimeout(statusTimer);
  if (myRole === 'none') return;
  if (soon) await new Promise((r) => setTimeout(r, 300));
  try {
    renderStatus(await api('GET', '/api/status'));
  } catch (e) {
    $('conn').dataset.state = 'down';
    $('status').textContent = e.message;
  }
  // A tab in the background doesn't poll; it catches up when shown again.
  if (!document.hidden) statusTimer = setTimeout(refreshStatus, 5000);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshStatus();
});

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
  const btn = el('button', { class: 'btn btn-quiet btn-sm danger', title: label, 'data-min-role': roleForCommand(command) }, icon(iconName), label);
  btn.addEventListener('click', async () => {
    if (confirmOpts && !(await confirmAction(confirmOpts))) return;
    busy(btn, () => mutate(command));
  });
  return btn;
}

const banMeta = (b) => [b.reason && b.reason !== 'Banned by an operator.' ? b.reason : null, b.source && `by ${b.source}`, b.expires && b.expires !== 'forever' ? `until ${b.expires}` : null].filter(Boolean).join(' · ');

// One table of everyone the server knows: players from the logs (history),
// the whitelist, operators and bans, merged by name. A row opens the
// player's profile with every action; filters replace the old lists.
let peopleFilter = 'all';
let historyData = null;
const lc = (n) => String(n).toLowerCase();

function peopleRows(a) {
  const map = new Map();
  const get = (name, uuid) => {
    const k = lc(name);
    if (!map.has(k)) map.set(k, { name, uuid: uuid || null });
    const p = map.get(k);
    if (uuid && !p.uuid) p.uuid = uuid;
    return p;
  };
  for (const h of historyData?.players || []) Object.assign(get(h.name, h.uuid), { last: h.last, first: h.first, playtime: h.playtime, sessions: h.sessions, history: h });
  for (const w of a.whitelist) get(w.name, w.uuid).whitelisted = true;
  for (const o of a.ops) get(o.name, o.uuid).op = o.level;
  for (const b of a.bans) get(b.name, b.uuid).ban = b;
  for (const name of lastStatus?.game?.players?.players || []) get(name).online = true;
  return [...map.values()].sort((x, y) => (y.online ? 1 : 0) - (x.online ? 1 : 0) || (y.last || 0) - (x.last || 0) || x.name.localeCompare(y.name));
}

const FILTERS = {
  all: () => true,
  online: (p) => p.online,
  whitelist: (p) => p.whitelisted,
  op: (p) => p.op != null,
  banned: (p) => p.ban,
};

function personAccess(p) {
  return el('span', { class: 'badges' },
    p.online ? el('span', { class: 'pill ok' }, el('span', { class: 'dot', 'aria-hidden': 'true' }), 'Online') : null,
    p.op != null ? el('span', { class: 'pill own', title: `Permission level ${p.op}` }, icon('op'), 'Operator') : null,
    p.whitelisted ? el('span', { class: 'pill' }, 'Whitelisted') : null,
    p.ban ? el('span', { class: 'pill bad', title: banMeta(p.ban) || 'Banned' }, icon('ban'), 'Banned') : null,
    !p.online && p.op == null && !p.whitelisted && !p.ban ? el('span', { class: 'sub' }, accessCache?.whitelistEnabled ? 'Not whitelisted' : 'Visitor') : null);
}

// Quick actions on the row; everything else is in the profile.
function personActions(p) {
  return [
    p.ban ? rowActionBtn('Unban', 'check', `pardon ${p.name}`)
      : p.whitelisted ? rowActionBtn('Remove', 'remove', `whitelist remove ${p.name}`, { title: `Take ${p.name} off the whitelist?`, body: accessCache?.whitelistEnabled ? `${p.name} can't join any more${p.online ? ' and is kicked if the server enforces the whitelist' : ''}.` : '', confirm: 'Remove', tone: 'danger', icon: 'remove' }, true)
        : rowActionBtn('Whitelist', 'add', `whitelist add ${p.name}`),
    el('button', { class: 'btn btn-quiet btn-sm', onclick: (e) => { e.stopPropagation(); openPlayer(p.name, p.uuid); } }, icon('players'), 'Profile'),
  ];
}

function renderPeople() {
  if (!accessCache) return;
  const rows = peopleRows(accessCache);
  const q = lc($('ph-filter').value.trim());
  const shown = rows.filter(FILTERS[peopleFilter]).filter((p) => !q || lc(p.name).includes(q));
  for (const b of $('pp-filter').children) {
    const n = rows.filter(FILTERS[b.dataset.f]).length;
    b.dataset.count = n;
    b.setAttribute('aria-label', `${b.textContent.replace(/\d+$/, '').trim()}, ${n}`);
  }
  $('pp-list').replaceChildren(...(shown.length
    ? shown.map((p) => el('tr', { class: 'clickable', onclick: (e) => { if (!e.target.closest('button, a')) openPlayer(p.name, p.uuid); } },
        el('td', { class: 'primary-cell', 'data-label': 'Player' }, el('div', { class: 'plugin' }, avatar(p.uuid || p.name), el('div', {}, p.name, p.op != null ? el('span', { class: 'sub' }, `Level ${p.op}`) : null))),
        el('td', { 'data-label': 'Access' }, personAccess(p)),
        el('td', { 'data-label': 'Last seen' }, p.online ? 'Now' : p.last ? el('span', { title: fmt.date(new Date(p.last).toISOString()) }, fmt.relative(new Date(p.last).toISOString())) : el('span', { class: 'sub' }, historyData ? 'Never joined' : '–')),
        el('td', { class: 'num', 'data-label': 'Playtime' }, p.playtime ? dur(p.playtime) : '–'),
        el('td', { class: 'act' }, personActions(p))))
    : [emptyRow(5, rows.length
      ? (q ? `Nobody called “${q}” here.` : 'Nobody in this list.')
      : accessCache.whitelistEnabled ? 'Nobody is whitelisted, so nobody can join. Add players above.' : 'Nobody has played yet. Add players to the whitelist above, then switch it on.')]));
}

async function loadAccess() {
  if (!accessLoaded) skeletonRows($('pp-list'), 5);
  try {
    const [a, h] = await Promise.all([api('GET', '/api/access'), atLeast('moderator') ? api('GET', '/api/players/history').catch(() => null) : null]);
    accessLoaded = true;
    accessCache = a;
    if (h) historyData = h;
    $('access-error').hidden = true;
    $('wl-toggle').checked = a.whitelistEnabled;
    $('wl-state').textContent = a.whitelistEnabled ? 'Whitelist on' : 'Whitelist off';
    $('n-ipbans').textContent = a.ipBans.length || '';
    $('list-ipbans').replaceChildren(...(a.ipBans.length
      ? a.ipBans.map((b) => el('li', {},
          el('span', { class: 'ip-tile' }, icon('ban')),
          el('span', { class: 'who-cell' }, el('span', { class: 'name mono' }, b.ip), el('span', { class: 'meta' }, banMeta(b) || 'No reason given')),
          rowAction('Unban', 'check', `pardon-ip ${b.ip}`)))
      : [emptyItem('No banned IP addresses.')]));
    if (historyData) {
      const now = Date.now();
      statList('ph-kpis', [
        ['Players seen', String(historyData.players.length)],
        ['Online now', String(lastStatus?.game?.players?.online ?? historyData.players.filter((p) => p.online).length)],
        ['Active this week', String(historyData.players.filter((p) => now - p.last < 7 * 86400000).length)],
        ['Played, 30 days', dur(historyData.daily.reduce((n, d) => n + d.playtime, 0))],
      ]);
      $('ph-info').textContent = `Players from ${historyData.files} log file${historyData.files === 1 ? '' : 's'}; old logs are remembered even after they are deleted.`;
    }
    $('ph-kpis').hidden = !historyData;
    renderPeople();
    if (atLeast('moderator')) loadJoin();
  } catch (e) {
    $('access-error').hidden = false;
    $('access-error').textContent = `Can't read the player lists: ${e.message}`;
  }
}
tabLoaders.players = loadAccess;

// ---------------------------------------------------------------------------
// Knock to join: players turned away by the whitelist, and invite links
// ---------------------------------------------------------------------------

let joinData = null;
let joinPending = 0;

function joinMeta(r) {
  const tries = r.via === 'invite' ? 'used an invite' : r.count > 1 ? `tried ${r.count}×` : 'tried to join';
  return [tries, r.via === 'invite' && r.invite ? `“${r.invite}”` : null, fmt.relative(r.last), r.ip].filter(Boolean).join(' · ');
}

async function answerJoin(r, verb, button) {
  await busy(button, async () => {
    try {
      await api('POST', `/api/join/${r.id}/${verb}`);
      toast(verb === 'allow' ? `${r.name} is whitelisted and can join now.` : `Ignored ${r.name}. New tries won't alert you for a week.`);
      if (verb === 'allow') {
        await new Promise((res) => setTimeout(res, 400)); // whitelist.json is written asynchronously
        await loadAccess();
      } else await loadJoin();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
}

function renderJoin() {
  const pending = joinData.requests.filter((r) => r.status === 'pending');
  joinPending = pending.length;
  renderSecurityBadge(lastStatus?.security);
  $('join-panel').hidden = !pending.length;
  $('join-info').textContent = joinData.notifications
    ? `Players who aren't whitelisted and tried to join, or used an invite link.${joinData.oneTap ? ' You can also allow them from the notification.' : ''}`
    : "Players who aren't whitelisted and tried to join, or used an invite link. Set up notifications (Settings → Notifications) to hear about them right away.";
  $('join-list').replaceChildren(...pending.map((r) => {
    const allow = el('button', { class: 'btn btn-primary btn-sm', type: 'button' }, icon('check'), 'Allow');
    const ignore = el('button', { class: 'btn btn-quiet btn-sm', type: 'button' }, 'Ignore');
    allow.addEventListener('click', () => answerJoin(r, 'allow', allow));
    ignore.addEventListener('click', () => answerJoin(r, 'ignore', ignore));
    return el('li', {},
      avatar(r.uuid || r.name),
      el('span', { class: 'who-cell' }, el('span', { class: 'name' }, r.name), el('span', { class: 'meta', title: fmt.date(r.last) }, joinMeta(r))),
      el('span', { class: 'actions' }, ignore, allow));
  }));
  renderInvites();
}

function inviteMeta(i) {
  const uses = i.max === 1 ? (i.used ? 'used' : 'single use') : `${i.used} of ${i.max} used`;
  const until = !i.active ? (i.used >= i.max ? 'used up' : 'expired') : i.expires ? `until ${fmt.date(i.expires)}` : 'no expiry';
  return [uses, until, i.auto ? 'whitelists right away' : 'asks you first', i.names.length ? i.names.join(', ') : null].filter(Boolean).join(' · ');
}

function renderInvites() {
  const list = joinData?.invites || [];
  $('invite-list').replaceChildren(...(list.length
    ? list.map((i) => {
        const revoke = i.active ? el('button', { class: 'btn btn-quiet btn-sm danger', type: 'button' }, 'Withdraw') : null;
        revoke?.addEventListener('click', () => busy(revoke, async () => {
          try {
            await api('DELETE', `/api/invites/${i.id}`);
            toast('The link no longer works.');
            await loadJoin();
          } catch (e) {
            toast(e.message, 'bad');
          }
        }));
        return el('li', { class: i.active ? null : 'muted' },
          el('span', { class: 'ip-tile' }, icon('door')),
          el('span', { class: 'who-cell' }, el('span', { class: 'name' }, i.label || 'Invite'), el('span', { class: 'meta' }, inviteMeta(i))),
          revoke);
      })
    : [emptyItem('No invite links yet.')]));
}

async function loadJoin() {
  try {
    joinData = await api('GET', '/api/join');
    renderJoin();
  } catch (e) {
    $('join-panel').hidden = true;
  }
}

const INVITE_ADDR_KEY = 'rconsole.invite.address';
$('invite-toggle').addEventListener('click', () => {
  const f = $('invite-form');
  $('invite-link').hidden = true;
  try {
    if (!f.elements.address.value) f.elements.address.value = localStorage.getItem(INVITE_ADDR_KEY) || '';
  } catch {}
  renderInvites();
  openDrawer('drawer-invite', f.elements.label);
  loadJoin();
});
$('invite-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target;
  busy(f.querySelector('.btn-primary'), async () => {
    try {
      const { link } = await api('POST', '/api/invites', {
        label: f.elements.label.value.trim(),
        address: f.elements.address.value.trim(),
        days: Number(f.elements.days.value),
        uses: Number(f.elements.uses.value),
        auto: f.elements.auto.checked,
      });
      try {
        localStorage.setItem(INVITE_ADDR_KEY, f.elements.address.value.trim());
      } catch {}
      $('invite-url').value = link;
      $('invite-link').hidden = false;
      $('invite-url').select();
      f.elements.label.value = '';
      await loadJoin();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
});
$('invite-copy').addEventListener('click', () => copyText($('invite-url').value, 'Invite link'));

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

document.querySelectorAll('form.add[data-cmd]').forEach((form) => {
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
      el('td', { class: 'num', 'data-label': 'Size', title: w.sizeIncomplete ? 'Some folders of this world can\'t be read by rconsole, so it is at least this big.' : null }, w.generated ? `${fmt.bytes(w.size)}${w.sizeIncomplete ? '+' : ''}` : '–'),
      el('td', { 'data-label': 'Last played' }, when(w.lastPlayed)),
      el('td', { class: 'act' },
        w.active ? null : worldButton('Switch', 'play', () => switchWorld(w.name)),
        w.generated ? worldButton('Back up', 'backups', () => backupWorld(w.name)) : null,
        w.active && w.generated && serverRunning() && atLeast('admin') ? worldButton('Pre-generate', 'worlds', () => pregenerateWorld(w.name)) : null,
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

async function pregenerateWorld(name) {
  const radius = el('select', { class: 'field' }, ...[1000, 2000, 3000, 5000, 10000].map((r) => el('option', { value: r, selected: r === 2000 || undefined }, `${r.toLocaleString()} blocks around spawn`)));
  if (!(await confirmAction({
    title: `Pre-generate ${name}?`,
    body: 'Chunky generates the land ahead of time, in the background, so exploring players don\'t cause lag later. It takes a while and uses CPU; run it when few players are online. Needs the Chunky plugin (Plugins → search "Chunky").',
    confirm: 'Start', tone: 'primary', icon: 'worlds',
    content: el('label', { class: 'fld' }, el('span', {}, 'Area'), radius),
  }))) return;
  try {
    await api('POST', `/api/worlds/${encodeURIComponent(name)}/pregenerate`, { radius: Number(radius.value) });
    toast(`Chunky is generating ${name}. Progress shows in the console; "chunky pause" pauses it.`);
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
  if (open) openDrawer('drawer-world', worldForm.elements.name);
  else closeDrawer('drawer-world');
}
$('world-new-toggle').addEventListener('click', () => toggleWorldForm(true));
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

// --- Import a world from an archive -------------------------------------------
// The archive goes up in chunks (resumable after a dropped connection), then
// the helper unpacks and checks it and moves the world into place. The
// upload keeps going when the drawer is closed; reopening shows it.

const importForm = $('world-import');
const importFileInput = $('import-file');
let importFile = null;
let importing = null; // { id, xhr, cancelled } while uploading

const ARCHIVE_EXT = /\.(zip|tar|tgz|txz|tzst|gz|zst|xz|bz2)$/i;
function worldNameFrom(fileName) {
  let n = fileName;
  while (ARCHIVE_EXT.test(n)) n = n.replace(ARCHIVE_EXT, '');
  n = n.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').replace(/_(nether|the_end)$/, '').slice(0, 32) || 'imported';
  let name = n;
  for (let i = 2; worldNames.includes(name); i++) name = `${n.slice(0, 29)}-${i}`;
  return name;
}
const validWorldName = (n) => /^[A-Za-z0-9_-]{1,32}$/.test(n) && !/_(nether|the_end)$/.test(n) && !/^[-.]/.test(n);

function renderImportOptions() {
  const name = importForm.elements.name.value.trim();
  const exists = worldNames.includes(name);
  const isActive = name === activeWorldName;
  const running = serverRunning();
  const box = $('import-options');
  const prev = { replace: box.querySelector('[name=replace]')?.checked, activate: box.querySelector('[name=activate]')?.checked, seconds: box.querySelector('[name=seconds]')?.value };
  const check = (field, label, note, checked) => el('label', { class: 'radio-row' },
    el('input', { type: 'checkbox', name: field, checked: checked || undefined }),
    el('span', {}, el('b', {}, label), el('span', { class: 'note' }, note)));
  const delay = delaySelect(Number(prev.seconds ?? 60));
  const rows = [];
  if (exists) {
    rows.push(check('replace', `Replace ${name}`,
      isActive
        ? `This is the active world. ${running ? 'Players are warned, the server stops, the world' : 'It'} is backed up for safety, then replaced${running ? ', and the server starts again' : ''}. Pick another name to keep both.`
        : 'It is backed up for safety, then replaced. Pick another name to keep both.', prev.replace));
    if (isActive && running) rows.push(fld('Stop the server', delay));
  } else {
    rows.push(check('activate', 'Switch to it after the import', running ? `The server restarts into it after a countdown. ${activeWorldName || 'The current world'} stays on disk.` : 'It is played from the next start.', prev.activate));
    if (running) rows.push(Object.assign(fld('Restart', delay), { hidden: !prev.activate }));
  }
  box.replaceChildren(...rows);
  box.onchange = () => {
    const act = box.querySelector('[name=activate]');
    const delayFld = box.querySelector('.fld');
    if (act && delayFld) delayFld.hidden = !act.checked;
  };
}

function pickImportFile(file) {
  if (!file || importing) return;
  importFile = file;
  $('import-file-name').textContent = file.name;
  const looksRight = ARCHIVE_EXT.test(file.name);
  $('import-file-note').textContent = `${fmt.bytes(file.size)}${looksRight ? '' : '. This doesn\'t look like a .zip or .tar archive; it is checked once the upload starts.'}`;
  $('import-drop').dataset.state = 'picked';
  importForm.elements.name.value = worldNameFrom(file.name);
  renderImportOptions();
}

function setImportBusy(on) {
  importing = on ? importing : null;
  for (const c of importForm.querySelectorAll('input, select')) c.disabled = on;
  $('import-drop').toggleAttribute('aria-disabled', on);
  $('world-import-go').hidden = on;
  $('world-import-cancel').textContent = on ? 'Cancel upload' : 'Cancel';
  $('import-progress').hidden = !on;
  $('world-import-toggle').lastChild.textContent = on ? 'Uploading…' : 'Import world';
}

function resetImport() {
  importFile = null;
  importForm.reset();
  importFileInput.value = '';
  $('import-file-name').textContent = 'Choose a world archive';
  $('import-file-note').textContent = 'or drop it here. A .zip of the world folder (as Finder or Windows make it), .tar.gz, .tar.zst or .tar.xz; a zip of a whole server folder works too. Nether and End come along.';
  delete $('import-drop').dataset.state;
  $('import-meter').style.width = '0';
  $('import-options').replaceChildren();
  setImportBusy(false);
}

// One chunk, with upload progress (fetch can't report it).
function putChunk(base, id, offset, blob, onProgress, holder) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    holder.xhr = xhr;
    xhr.open('PUT', `${base}/${id}?offset=${offset}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status === 401) location.replace('/login');
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(Object.assign(new Error(data.error || `Upload failed (HTTP ${xhr.status})`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error('Connection lost'));
    xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { cancelled: true }));
    xhr.send(blob);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sends `file` to an upload endpoint (base: /api/…/uploads) in resumable
// chunks; resolves with the upload id. holder.cancelled stops it.
async function chunkedUpload(base, file, holder, show, onRetry = () => {}) {
  const up = await api('POST', base, { name: file.name, size: file.size });
  holder.id = up.id;
  let offset = up.received;
  let failures = 0;
  show(offset);
  // Chunks of about 20 seconds each: big on a fast line, small enough on a
  // slow one to finish well inside proxy and server request timeouts.
  let chunk = 4 * 1024 * 1024;
  while (offset < file.size) {
    if (holder.cancelled) throw Object.assign(new Error('Upload cancelled'), { cancelled: true });
    const start = offset;
    const end = Math.min(file.size, offset + chunk);
    const t0 = Date.now();
    try {
      offset = (await putChunk(base, up.id, offset, file.slice(offset, end), (loaded) => show(start + loaded), holder)).received;
      const perSecond = (end - start) / Math.max(0.05, (Date.now() - t0) / 1000);
      chunk = Math.max(1024 * 1024, Math.min(up.chunkSize, Math.round(perSecond * 20)));
      failures = 0;
    } catch (e) {
      // Wrong file, no space, signed out: no point retrying.
      if (e.cancelled || (e.status && e.status < 500 && ![408, 409, 429].includes(e.status))) throw e;
      if (++failures > 8) throw new Error(`Upload failed: ${e.message}`);
      for (let s = Math.min(30, 2 ** failures); s > 0 && !holder.cancelled; s--) {
        onRetry(`${e.message}. Retrying in ${s}s…`);
        await sleep(1000);
      }
      offset = await api('GET', `${base}/${up.id}`).then((st) => st.received).catch(() => offset);
    }
    show(offset);
  }
  return up.id;
}

async function uploadArchive(file) {
  const started = Date.now();
  const show = (sent) => {
    const pct = (sent / file.size) * 100;
    $('import-meter').style.width = `${pct.toFixed(1)}%`;
    const secs = (Date.now() - started) / 1000;
    const rate = secs > 1 ? sent / secs : 0;
    const left = rate ? Math.round((file.size - sent) / rate) : null;
    $('import-status').textContent = `${fmt.bytes(sent)} of ${fmt.bytes(file.size)}${rate ? ` · ${fmt.bytes(rate)}/s` : ''}${left != null && left > 0 ? ` · ${left < 60 ? `${left}s` : fmt.duration(left)} left` : ''}`;
    $('world-import-toggle').lastChild.textContent = `Uploading ${Math.floor(pct)}%`;
  };
  return chunkedUpload('/api/worlds/uploads', file, importing, show, (msg) => ($('import-status').textContent = msg));
}

importForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (importing) return;
  const f = importForm.elements;
  const name = f.name.value.trim();
  if (!importFile) return toast('Choose a world archive first.', 'bad');
  if (!validWorldName(name)) return toast('World names use letters, digits, - and _ (max 32), and can\'t end in _nether or _the_end.', 'bad');
  const exists = worldNames.includes(name);
  const replace = Boolean(importForm.querySelector('[name=replace]')?.checked);
  const activate = Boolean(importForm.querySelector('[name=activate]')?.checked);
  const seconds = Number(importForm.querySelector('[name=seconds]')?.value ?? 60);
  if (exists && !replace) return toast(`A world named ${name} exists. Tick "Replace" or pick another name.`, 'bad');
  if (lastStatus?.op?.running) return toast(`Wait for "${lastStatus.op.label}" to finish first.`, 'bad');
  if (replace && name === activeWorldName && serverRunning() && !(await confirmAction({
    title: `Replace the active world ${name}?`,
    body: 'After the upload, players are warned, the server stops, the current world is backed up, and the uploaded one takes its place. The backup is under Backups if you want it back.',
    confirm: 'Upload and replace', tone: 'danger', icon: 'worlds',
  }))) return;
  importing = { id: null, xhr: null, cancelled: false };
  setImportBusy(true);
  const file = importFile;
  try {
    const upload = await uploadArchive(file);
    $('import-status').textContent = 'Uploaded. Starting the import…';
    const op = await api('POST', '/api/worlds/import', { upload, name, replace, activate, seconds });
    renderOp(op);
    refreshStatus(true);
    toast(`${file.name} is uploaded. Importing it as ${name}; the bar at the top shows the progress.`);
    resetImport();
    closeDrawer('drawer-import');
  } catch (err) {
    const id = importing?.id;
    if (id && err.status !== 415) api('DELETE', `/api/worlds/uploads/${id}`).catch(() => {}); // 415: the server dropped it already
    if (!err.cancelled) toast(err.message, 'bad');
    setImportBusy(false);
    $('import-meter').style.width = '0';
  }
});

$('world-import-toggle').addEventListener('click', () => {
  if (!importing && !importFile) resetImport();
  else if (!importing) renderImportOptions();
  openDrawer('drawer-import', importing ? $('world-import-cancel') : $('import-file'));
});
$('world-import-cancel').addEventListener('click', () => {
  if (importing) {
    importing.cancelled = true;
    importing.xhr?.abort();
    return;
  }
  resetImport();
  closeDrawer('drawer-import');
});
importFileInput.addEventListener('change', () => pickImportFile(importFileInput.files[0]));
importForm.elements.name.addEventListener('input', renderImportOptions);
const dropzone = $('import-drop');
for (const type of ['dragenter', 'dragover']) dropzone.addEventListener(type, (e) => {
  e.preventDefault();
  if (!importing) dropzone.dataset.over = '';
});
for (const type of ['dragleave', 'drop']) dropzone.addEventListener(type, () => delete dropzone.dataset.over);
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  const item = e.dataTransfer.items?.[0];
  if (item?.webkitGetAsEntry?.()?.isDirectory) return toast('That is a folder. Zip it first (Finder: right-click → Compress; Windows: Send to → Compressed folder), then drop the .zip.', 'bad');
  pickImportFile(e.dataTransfer.files[0]);
});
window.addEventListener('beforeunload', (e) => {
  if (importing) e.preventDefault();
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
            el('td', { 'data-label': 'Created' }, when(f.created)),
            el('td', { class: 'act' },
              worldButton('Restore', 'rollback', () => restoreBackup(f)),
              el('a', { class: 'btn btn-quiet btn-sm', href: `/api/backups/${encodeURIComponent(f.name)}`, download: f.name }, icon('download'), 'Download'),
              offsiteView?.configured ? el('button', { class: 'btn btn-quiet btn-sm', title: 'Copy to the offsite bucket', onclick: (e) => uploadOffsite(f.name, e.currentTarget) }, icon('updates'), 'Upload') : null,
              deleteBackupButton(f.name)));
        })
      : [emptyRow(5, el('b', {}, 'No backups yet. '), 'A backup archives a world with its nether and end into a .tar.zst (or .tar.gz) while autosave is paused. Add a nightly backup under Schedule.')]));
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

function loadBackupsArea() {
  loadOffsite().then(loadBackups);
  if (!worldsLoaded) loadWorlds(); // restore needs the world names
}

// ---------------------------------------------------------------------------
// Offsite copies
// ---------------------------------------------------------------------------

let offsiteView = null;
let offsiteTimer = null;
let osDirty = false;

function renderOffsiteState(o) {
  const st = o.state || {};
  if (st.running) setJob($('os-state'), 'running', 'updates', `Uploading ${st.running}${st.progress != null ? ` · ${Math.round(st.progress * 100)}%` : ''}${st.queued ? ` · ${st.queued} more queued` : ''}`);
  else if (st.error) setJob($('os-state'), 'failed', 'alert', `Last upload failed: ${st.error}`);
  else setJob($('os-state'), null);
  clearTimeout(offsiteTimer);
  if ((st.running || st.queued) && document.body.dataset.area === 'backups') offsiteTimer = setTimeout(() => loadOffsite(), 2000);
  else if (offsiteView?.state?.running && !st.running) loadOffsiteList();
}

async function loadOffsite() {
  if (!globalAtLeast('admin')) return;
  try {
    const o = await api('GET', '/api/offsite');
    const was = offsiteView;
    offsiteView = o;
    const f = $('os-form').elements;
    if (!was || !osDirty) { // don't overwrite what someone is typing
      for (const k of ['endpoint', 'bucket', 'region', 'accessKeyId', 'secretAccessKey', 'prefix', 'passphrase']) f[k].value = o[k] || '';
      f.keep.value = o.keep;
      f.auto.checked = o.auto;
      f.pathStyle.checked = o.pathStyle;
    }
    $('os-edit').querySelector('span').textContent = o.configured ? 'Settings' : 'Set up';
    $('os-info').textContent = o.configured
      ? `${o.bucket} at ${new URL(o.endpoint).host}${o.encrypted ? ', encrypted' : ''}. ${o.auto ? 'Every new backup is uploaded' : 'Uploads are manual'}; the newest ${o.keep || 'all'} of each world are kept.${o.last ? ` Last upload ${fmt.relative(o.last.at)}.` : ''}`
      : 'Keep copies of your backups outside this machine, in any S3-compatible bucket: Backblaze B2, Cloudflare R2, AWS S3, Wasabi or MinIO.';
    $('os-table').hidden = !o.configured;
    renderOffsiteState(o);
    if (o.configured && (!was || !was.configured)) loadOffsiteList();
  } catch (e) {
    $('os-info').textContent = e.message;
  }
}

async function loadOffsiteList() {
  if (!offsiteView?.configured) return;
  skeletonRows($('os-list'), 5);
  try {
    const { items } = await api('GET', '/api/offsite/list');
    $('os-list').replaceChildren(...(items.length
      ? items.map((x) => el('tr', {},
          el('td', { class: 'primary-cell', 'data-label': 'Copy' }, el('span', { class: 'filename' }, x.file), x.encrypted ? el('span', { class: 'sub' }, 'Encrypted') : null),
          el('td', { 'data-label': 'World' }, x.world),
          el('td', { class: 'num', 'data-label': 'Size' }, fmt.bytes(x.size)),
          el('td', { 'data-label': 'Uploaded' }, when(x.modified)),
          el('td', { class: 'act' },
            el('button', { class: 'btn btn-quiet btn-sm', onclick: (e) => downloadOffsite(x, e.currentTarget) }, icon('download'), 'Bring back'),
            el('button', { class: 'btn btn-quiet btn-sm danger', onclick: (e) => deleteOffsite(x, e.currentTarget) }, icon('delete'), 'Delete'))))
      : [emptyRow(5, el('b', {}, 'No copies yet. '), offsiteView.auto ? 'The next backup is uploaded automatically, or use Upload on a backup above.' : 'Use Upload on a backup above, or turn on automatic uploads.')]));
  } catch (e) {
    $('os-list').replaceChildren(emptyRow(5, `Can't list the bucket: ${e.message}`));
  }
}

async function uploadOffsite(name, btn) {
  await busy(btn, async () => {
    try {
      renderOffsiteState(offsiteView = await api('POST', '/api/offsite/upload', { file: name }));
      toast(`Uploading ${name}`);
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
}

async function downloadOffsite(x, btn) {
  if (!(await confirmAction({ title: 'Bring this copy back?', body: `${x.file} is downloaded${x.encrypted ? ' and decrypted' : ''} into the backup folder. Restore it from the list of backups afterwards.`, confirm: 'Download', icon: 'download' }))) return;
  await busy(btn, async () => {
    try {
      await api('POST', '/api/offsite/download', { name: x.name });
      toast(`${x.file} is back in the backup folder.`);
      loadBackups();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
}

async function deleteOffsite(x, btn) {
  if (!(await confirmAction({ title: 'Delete this offsite copy?', body: `${x.name}\nThis can't be undone.`, confirm: 'Delete copy', tone: 'danger', icon: 'delete' }))) return;
  await busy(btn, async () => {
    try {
      await api('DELETE', `/api/offsite/${encodeURIComponent(x.name)}`);
      toast(`Deleted ${x.name}`);
      loadOffsiteList();
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
}

function offsiteBody() {
  const f = $('os-form').elements;
  return {
    endpoint: f.endpoint.value, bucket: f.bucket.value.trim(), region: f.region.value.trim() || 'us-east-1', accessKeyId: f.accessKeyId.value.trim(),
    secretAccessKey: f.secretAccessKey.value, prefix: f.prefix.value, passphrase: f.passphrase.value,
    keep: f.keep.value === '' ? 14 : Number(f.keep.value), auto: f.auto.checked, pathStyle: f.pathStyle.checked,
  };
}

$('os-form').addEventListener('input', () => { osDirty = true; });
$('os-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await busy(e.submitter || $('os-form').querySelector('.btn-primary'), async () => {
    try {
      offsiteView = await api('PUT', '/api/offsite', offsiteBody());
      $('os-note').textContent = '';
      osDirty = false;
      toast('Offsite settings saved.');
      closeDrawer('drawer-offsite');
      await loadOffsite();
      loadOffsiteList();
      loadBackups();
    } catch (err) {
      $('os-note').textContent = err.message;
    }
  });
});
$('os-test').addEventListener('click', async (e) => {
  await busy(e.currentTarget, async () => {
    try {
      await api('PUT', '/api/offsite', offsiteBody());
      const r = await api('POST', '/api/offsite/test');
      $('os-note').textContent = `Connected. ${r.objects} object${r.objects === 1 ? '' : 's'} in the folder.`;
    } catch (err) {
      $('os-note').textContent = `Connection failed: ${err.message}`;
    }
  });
});
viewLoaders['world/worlds'] = loadWorlds;
tabLoaders.backups = loadBackupsArea;
$('os-edit').addEventListener('click', () => openDrawer('drawer-offsite'));

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
    ? p.error || `rconsole can't control ${p.unit || 'the server service'}. See the README (polkit rule).`
    : p.active === 'active' && p.since ? `Since ${fmt.date(p.since)} (${fmt.relative(p.since)})${p.pid ? ` · PID ${p.pid}` : ''}`
      : p.active === 'failed' ? p.result : '';
  const busyNow = Boolean(p.pending) || s.op?.running || s.restart?.remaining != null;
  $('power-start').disabled = !p.available || p.active === 'active' || busyNow;
  $('power-stop').disabled = !p.available || p.active !== 'active' || busyNow;
  $('power-restart').disabled = !p.available || p.active !== 'active' || busyNow;
  renderPending(s.pending);
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

function renderPending(items = []) {
  $('pending-bar').hidden = !items.length;
  $('pending-list').textContent = items.length ? `${items.length === 1 ? '1 change waits' : `${items.length} changes wait`} for the next start: ${items.join(', ')}.` : '';
  $('pending-restart').disabled = !serverRunning() || Boolean(lastStatus?.restart?.remaining != null);
}
$('pending-restart').addEventListener('click', async () => {
  const delay = delaySelect(60);
  if (!(await confirmAction({ title: 'Restart to apply changes?', body: 'Players are warned, the world is saved and the server comes straight back with the new settings and plugins.', confirm: 'Restart server', icon: 'restart', content: fld('Restart', delay) }))) return;
  await startOp('/api/server/power', { action: 'restart', seconds: Number(delay.value) });
});

// ---------------------------------------------------------------------------
// Server: settings (server.properties)
// ---------------------------------------------------------------------------

let settingsSchema = [];
const settingsForm = $('settings-form');

function settingControl(raw) {
  const spec = { ...raw, value: raw.value ?? raw.default ?? null };
  const id = `set-${spec.key}`;
  const attrs = { id, name: spec.key, 'data-initial': spec.value ?? '' };
  if (spec.type === 'bool') {
    return el('label', { class: 'switch' }, el('input', { ...attrs, type: 'checkbox', role: 'switch', checked: spec.value === 'true' || undefined }), el('span', { 'data-switch-label': true }, spec.value === 'true' ? 'On' : 'Off'));
  }
  if (spec.type === 'enum') {
    return el('select', { ...attrs, class: 'field' }, ...spec.values.map((v) => el('option', { value: v, selected: v === spec.value || undefined }, v[0].toUpperCase() + v.slice(1))));
  }
  if (spec.type === 'int') return el('input', { ...attrs, class: 'field num', type: 'number', inputmode: 'numeric', min: spec.min, max: spec.max, step: 1, value: spec.value ?? '', placeholder: 'Default' });
  return el('input', { ...attrs, class: 'field', maxlength: spec.max, value: spec.value ?? '', placeholder: 'Default' });
}

const controlValue = (c) => (c.type === 'checkbox' ? String(c.checked) : c.value.trim());

function settingsChanges() {
  const out = [];
  for (const spec of settingsSchema) {
    const c = settingsForm.elements[spec.key];
    if (!c) continue;
    const v = controlValue(c);
    const initial = c.dataset.initial;
    if (c.type === 'checkbox' ? v !== String(initial === 'true') : v !== initial) out.push({ spec, from: initial, to: v, control: c });
  }
  return out;
}

function syncSettingsBar() {
  const changes = settingsChanges();
  for (const row of settingsForm.querySelectorAll('.setting')) row.classList.toggle('dirty', changes.some((c) => c.spec.key === row.dataset.key));
  for (const sw of settingsForm.querySelectorAll('.switch input')) sw.nextElementSibling.textContent = sw.checked ? 'On' : 'Off';
  $('settings-bar').hidden = !changes.length;
  $('settings-dirty').textContent = `${changes.length} unsaved change${changes.length === 1 ? '' : 's'}`;
}

async function loadSettings() {
  try {
    const { schema, other, pending } = await api('GET', '/api/settings');
    settingsSchema = schema;
    renderPending(pending);
    const groups = [...new Set(schema.map((s) => s.group))];
    $('settings-groups').replaceChildren(...groups.map((g) => el('section', { class: 'panel' },
      el('header', { class: 'panel-head' }, el('h2', {}, g)),
      el('div', { class: 'settings-list' }, ...schema.filter((s) => s.group === g).map((spec) => el('div', { class: 'setting', 'data-key': spec.key },
        el('label', { class: 'setting-label', for: `set-${spec.key}` }, el('span', {}, spec.label),
          el('span', { class: 'setting-key' }, spec.key, spec.value == null ? el('span', { class: 'setting-default' }, 'default') : null, spec.live ? el('span', { class: 'pill own', title: 'Applied immediately over RCON while the server runs' }, 'live') : null),
          spec.warning ? el('span', { class: 'setting-warn' }, icon('alert'), spec.warning) : null),
        settingControl(spec)))))));
    $('settings-other').replaceChildren(...(other.length
      ? other.map((o) => el('tr', {}, el('td', { class: 'mono-cell' }, o.key), el('td', { class: 'mono-cell' }, o.value === '' ? el('span', { class: 'sub' }, 'empty') : o.value)))
      : [emptyRow(2, 'No other properties.')]));
    syncSettingsBar();
  } catch (e) {
    $('settings-groups').replaceChildren(el('section', { class: 'panel' }, el('div', { class: 'panel-body note' }, `Can't read server.properties: ${e.message}`)));
  }
}
viewLoaders['server/properties'] = loadSettings;

settingsForm.addEventListener('input', syncSettingsBar);
settingsForm.addEventListener('change', syncSettingsBar);
$('settings-discard').addEventListener('click', loadSettings);
settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const changes = settingsChanges();
  for (const { spec, control } of changes) {
    const bad = spec.type === 'int' && (control.value === '' || !control.checkValidity());
    control.setAttribute('aria-invalid', bad);
    if (bad) {
      control.focus();
      return toast(`${spec.label}: enter a whole number from ${spec.min} to ${spec.max}.`, 'bad');
    }
  }
  if (!changes.length) return;
  const running = serverRunning();
  const show = (v) => (v === '' ? 'empty' : v);
  const diff = el('ul', { class: 'diff' }, ...changes.map(({ spec, from, to }) => el('li', {},
    el('b', {}, spec.label),
    el('span', { class: 'diff-values' }, el('del', {}, show(from)), ' → ', el('ins', {}, show(to))),
    el('span', { class: 'note' }, spec.live && running ? 'Applies now' : 'Applies on next start'))));
  const risky = changes.some((c) => c.spec.warning && c.to === 'false');
  if (!(await confirmAction({
    title: `Apply ${changes.length} change${changes.length === 1 ? '' : 's'}?`,
    body: risky ? changes.find((c) => c.spec.warning).spec.warning : '',
    confirm: 'Apply', tone: risky ? 'danger' : 'primary', icon: 'settings', content: diff,
  }))) return;
  await busy(settingsForm.querySelector('[type=submit]'), async () => {
    try {
      const r = await api('POST', '/api/settings', { set: Object.fromEntries(changes.map((c) => [c.spec.key, c.to])) });
      toast(r.restart.length ? `Saved. ${r.live.length ? `${r.live.length} applied now, ` : ''}${r.restart.length} on next start.` : 'Saved and applied.');
      refreshStatus(true);
      loadSettings();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
});

// ---------------------------------------------------------------------------
// Server: plugins (Modrinth)
// ---------------------------------------------------------------------------

let pluginsLoaded = false;

function pluginIcon(url) {
  if (!url) return el('span', { class: 'plugin-tile' }, icon('plugins'));
  const img = el('img', { class: 'plugin-tile', src: url, alt: '', loading: 'lazy', width: 32, height: 32 });
  img.addEventListener('error', () => img.replaceWith(el('span', { class: 'plugin-tile' }, icon('plugins'))));
  return img;
}

function pluginJob(btn, method, url, body, message) {
  return busy(btn, async () => {
    try {
      const r = await api(method, url, body);
      toast(typeof message === 'function' ? message(r) : message);
      refreshStatus(true);
      loadPlugins();
      return true;
    } catch (e) {
      toast(e.message, 'bad');
      return false;
    }
  });
}

function pluginButton(label, iconName, fn, { danger, primary } = {}) {
  const btn = el('button', { class: `btn btn-sm ${primary ? 'btn-primary' : 'btn-quiet'}${danger ? ' danger' : ''}` }, icon(iconName), label);
  btn.addEventListener('click', () => fn(btn));
  return btn;
}

function pluginRow(p) {
  const file = encodeURIComponent(p.file);
  const meta = [p.version ? `v${p.version}` : null, p.authors.length ? `by ${p.authors.join(', ')}` : null].filter(Boolean).join(' · ');
  return el('tr', { class: p.enabled ? null : 'off' },
    el('td', { class: 'primary-cell', 'data-label': 'Plugin' },
      el('div', { class: 'plugin' }, pluginIcon(p.modrinth?.icon),
        el('div', {},
          el('span', {}, p.modrinth?.title || p.name, ' ',
            !p.enabled ? el('span', { class: 'pill' }, 'Disabled') : null,
            p.update ? el('span', { class: 'pill own' }, icon('updates'), `${p.update.version} available`) : null,
            p.error ? el('span', { class: 'pill bad' }, icon('alert'), p.error) : null,
            p.changed ? el('span', { class: 'pill bad', title: 'This jar is not the file rconsole downloaded and checked. Something on the server rewrote it, which is how plugin malware spreads. Remove it and reinstall from Modrinth.' }, icon('alert'), 'Changed since installed') : null),
          el('span', { class: 'sub' }, meta || p.file, ' · ', p.modrinth
            ? el('a', { class: 'link', href: `https://modrinth.com/plugin/${encodeURIComponent(p.modrinth.slug || p.modrinth.projectId)}`, target: '_blank', rel: 'noopener' }, 'Modrinth')
            : el('span', { class: 'unverified', title: 'Modrinth doesn\'t know this exact file, so rconsole can\'t check where it came from. Only run jars from sources you trust.' }, 'not verified')),
          p.description ? el('span', { class: 'sub clamp' }, p.description) : null))),
    el('td', { class: 'num', 'data-label': 'Size' }, fmt.bytes(p.size)),
    el('td', { class: 'act' },
      p.update ? pluginButton('Update', 'updates', (b) => updatePlugin(p, b), { primary: true }) : null,
      p.canRollback ? pluginButton('Roll back', 'rollback', (b) => rollbackPlugin(p, b)) : null,
      pluginButton(p.enabled ? 'Disable' : 'Enable', p.enabled ? 'pause' : 'play', (b) =>
        pluginJob(b, 'POST', `/api/plugins/${file}/toggle`, { enabled: !p.enabled }, `${p.name} ${p.enabled ? 'disabled' : 'enabled'}. Restart to apply.`)),
      pluginButton('Remove', 'delete', (b) => removePlugin(p, b), { danger: true })));
}

async function updatePlugin(p, btn) {
  if (!(await confirmAction({
    title: `Update ${p.modrinth?.title || p.name}?`,
    body: `${p.version || p.file} → ${p.update.version}. The current jar is kept so you can roll back. The new version loads on the next start.`,
    confirm: 'Update', icon: 'updates',
  }))) return;
  await pluginJob(btn, 'POST', `/api/plugins/${encodeURIComponent(p.file)}/update`, null, (r) => `Installed ${r.file}. Restart to apply.`);
}

async function rollbackPlugin(p, btn) {
  if (!(await confirmAction({ title: `Roll back ${p.name}?`, body: 'Puts the jar from before the last update back. Applies on the next start.', confirm: 'Roll back', icon: 'rollback' }))) return;
  await pluginJob(btn, 'POST', `/api/plugins/${encodeURIComponent(p.file)}/rollback`, null, (r) => `Rolled back to ${r.file}. Restart to apply.`);
}

async function removePlugin(p, btn) {
  if (!(await confirmAction({
    title: `Remove ${p.name}?`,
    body: `${p.file} is moved to the plugin trash in the backup folder. Its config folder in plugins/ is left alone. The server unloads it on the next start.`,
    confirm: 'Remove plugin', tone: 'danger', icon: 'delete',
  }))) return;
  await pluginJob(btn, 'DELETE', `/api/plugins/${encodeURIComponent(p.file)}`, null, `${p.name} removed. Restart to apply.`);
}

async function loadPlugins(refresh) {
  if (!pluginsLoaded) skeletonRows($('plugin-list'), 4);
  const btn = $('plugins-refresh');
  btn.setAttribute('aria-busy', 'true');
  try {
    const o = await api('GET', `/api/plugins${refresh ? '?refresh' : ''}`);
    pluginsLoaded = true;
    renderPending(o.pending);
    const updates = o.plugins.filter((p) => p.update).length;
    // Jars that wait for a restart aren't loaded yet; say so instead of one number.
    const waiting = (o.pending || []).filter((x) => /^install /.test(x)).length;
    const count = `${o.plugins.length - waiting} installed${waiting ? `, ${waiting} after the next restart` : ''}`;
    $('plugins-info').textContent = o.remoteError
      ? `${count}. Can't reach Modrinth: ${o.remoteError}`
      : `${count}, for Minecraft ${o.gameVersion || '?'}${updates ? `; ${updates} update${updates === 1 ? '' : 's'} available` : ''}. Changes apply on the next start.`;
    if (refresh) toast(o.remoteError ? `Couldn't check Modrinth: ${o.remoteError}` : updates ? `${updates} update${updates === 1 ? '' : 's'} available.` : 'All Modrinth plugins are up to date.', o.remoteError ? 'bad' : 'ok');
    $('plugin-list').replaceChildren(...(o.plugins.length
      ? o.plugins.map(pluginRow)
      : [emptyRow(3, el('b', {}, 'No plugins yet. '), 'Search Modrinth below to add one; squaremap gives you a live web map.')]));
  } catch (e) {
    $('plugin-list').replaceChildren(emptyRow(3, `Can't list plugins: ${e.message}`));
  } finally {
    btn.removeAttribute('aria-busy');
  }
}
viewLoaders['server/plugins'] = () => loadPlugins();
$('plugins-refresh').addEventListener('click', () => loadPlugins(true));

$('plugin-search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = e.target.elements.q.value.trim();
  if (!q) return;
  const table = $('plugin-results-table');
  await busy(e.target.querySelector('button'), async () => {
    try {
      const { results } = await api('GET', `/api/plugins/search?q=${encodeURIComponent(q)}`);
      table.hidden = false;
      $('plugin-results').replaceChildren(...(results.length
        ? results.map((r) => el('tr', {},
            el('td', { class: 'primary-cell', 'data-label': 'Plugin' }, el('div', { class: 'plugin' }, pluginIcon(r.icon),
              el('div', {}, el('a', { class: 'link', href: `https://modrinth.com/plugin/${encodeURIComponent(r.slug)}`, target: '_blank', rel: 'noopener' }, r.title),
                r.exact ? null : el('span', { class: 'pill compat', title: 'No release for your Minecraft version yet. Plugins usually keep working on newer versions; check the server log after the restart.' }, `Up to ${r.newestGame || 'an older version'}`),
                el('span', { class: 'sub clamp' }, r.description)))),
            el('td', { 'data-label': 'Author' }, r.author),
            el('td', { class: 'num', 'data-label': 'Downloads' }, new Intl.NumberFormat(undefined, { notation: 'compact' }).format(r.downloads)),
            el('td', { class: 'act' }, r.installed
              ? el('span', { class: 'pill own' }, icon('check'), 'Installed')
              : pluginButton('Install', 'download', async (b) => {
                  const body = r.exact
                    ? 'The newest release for this server is downloaded from Modrinth, checked, and loaded on the next start.'
                    : `${r.title} has no release for your Minecraft version yet; its newest release (made for up to ${r.newestGame || 'an older version'}) is installed. Plugins usually keep working on newer versions. Check the server log after the restart.`;
                  if (!(await confirmAction({ title: `Install ${r.title}?`, body, confirm: 'Install', icon: 'plugins' }))) return;
                  if (await pluginJob(b, 'POST', '/api/plugins', { projectId: r.id, title: r.title }, (x) => `Installed ${x.file}${x.exact === false ? ` (made for ${x.gameVersions.slice(-1)[0] || 'an older version'})` : ''}. Restart to apply.`)) b.closest('td').replaceChildren(el('span', { class: 'pill own' }, icon('check'), 'Installed'));
                }, { primary: true }))))
        : [emptyRow(4, `Nothing on Modrinth matches “${q}” for this server software.`)]));
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
});

// ---------------------------------------------------------------------------
// Automation: tasks with a trigger and a chain of steps
// ---------------------------------------------------------------------------

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const STEP = {
  say: { label: 'Tell players', icon: 'send' },
  command: { label: 'Run a command', icon: 'console' },
  wait: { label: 'Wait', icon: 'history' },
  backup: { label: 'Back up the world', icon: 'backups' },
  restart: { label: 'Restart with countdown', icon: 'restart' },
  stop: { label: 'Stop with countdown', icon: 'stop' },
  start: { label: 'Start the server', icon: 'play' },
  'if-empty': { label: 'Only go on if nobody is online', icon: 'players' },
};
const EVENT_LABEL = { start: 'When the server starts', crash: 'When the server crashes', empty: 'When nobody is online', log: 'When the log shows a line' };
let tasksLoaded = false;
let taskMeta = { servers: [], shown: null, events: {} };
let editingTask = null; // id while editing

function describeDays(days) {
  if (!days.length || days.length === 7) return 'Daily';
  if (days.join() === '1,2,3,4,5') return 'Weekdays';
  if (days.join() === '0,6') return 'Weekends';
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_NAMES[d]).join(', ');
}

const secs = (s) => (s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`);
function describeStep(st) {
  switch (st.type) {
    case 'say': return `Tell players “${st.message}”`;
    case 'command': return `/${st.command}`;
    case 'wait': return `Wait ${secs(st.seconds)}`;
    case 'restart': return st.warnSeconds ? `Restart after ${secs(st.warnSeconds)} warning` : 'Restart now';
    case 'stop': return st.warnSeconds ? `Stop after ${secs(st.warnSeconds)} warning` : 'Stop now';
    default: return STEP[st.type]?.label || st.type;
  }
}

function describeTrigger(t) {
  if (t.type === 'time') return [t.time, describeDays(t.days)];
  if (t.type === 'cron') return [el('span', { class: 'mono' }, t.cron), 'Cron'];
  const extra = t.event === 'empty' ? `for ${t.minutes} min` : t.event === 'log' ? `“${t.match}”` : '';
  return [EVENT_LABEL[t.event] || t.event, [extra, `at most every ${t.cooldownMinutes} min`].filter(Boolean).join(', ')];
}

const serverLabel = (id) => (id === null ? (taskMeta.shown === null && lastStatus?.platform?.name) || 'Attached server' : taskMeta.servers.find((x) => x.id === id)?.name || id);
const taskTitle = (t) => t.name || t.steps.map((st) => STEP[st.type]?.label || st.type).join(', ');

async function loadTasks() {
  if (!tasksLoaded) skeletonRows($('task-list'), 6);
  try {
    const { tasks, servers, shown, events } = await api('GET', '/api/tasks');
    taskMeta = { servers, shown, events };
    tasksLoaded = true;
    $('n-tasks').textContent = tasks.length || '';
    const many = servers.length > 1;
    $('task-list').closest('table').classList.toggle('one-server', !many);
    $('task-list').closest('table').classList.add('task-table');
    $('task-list').replaceChildren(...(tasks.length
      ? tasks.map((t) => {
          const failed = /^error/i.test(t.lastResult || '');
          const [whenMain, whenSub] = describeTrigger(t.trigger);
          const running = t.running ? `Running: step ${t.running.step + 1} of ${t.steps.length}` : null;
          return el('tr', {},
            el('td', { class: 'primary-cell', 'data-label': 'Task' },
              taskTitle(t), ' ',
              el('span', { class: `pill ${t.enabled ? 'own' : ''}` }, running ? 'Running' : t.enabled ? 'Active' : 'Paused'),
              el('span', { class: 'sub step-chain' }, t.steps.map(describeStep).join(' → '))),
            el('td', { 'data-label': 'Server', class: 'task-server' }, serverLabel(t.server), t.server !== shown && t.steps.some((st) => st.type === 'backup' || st.type === 'if-empty') ? el('span', { class: 'sub' }, 'Runs while shown') : ''),
            el('td', { 'data-label': 'When' }, whenMain, el('span', { class: 'sub' }, whenSub)),
            el('td', { 'data-label': 'Next run' }, t.enabled && t.nextRun ? when(t.nextRun) : t.trigger.type === 'event' && t.enabled ? 'On event' : '–'),
            el('td', { 'data-label': 'Last result' }, running
              ? el('span', { class: 'result' }, running)
              : t.lastRun
                ? el('span', { class: `result ${failed ? 'bad' : ''}` }, t.lastResult, el('span', { class: 'sub' }, fmt.relative(t.lastRun)))
                : el('span', { class: 'result' }, 'Not run yet')),
            el('td', { class: 'act' },
              taskButton('Run now', 'play', () => runTask(t)),
              taskButton('Edit', 'settings', () => editTask(t), false, true),
              taskButton(t.enabled ? 'Pause' : 'Resume', t.enabled ? 'pause' : 'play', () => taskAction('PATCH', t, { enabled: !t.enabled }), false, true),
              taskButton('Delete', 'delete', async () => {
                if (await confirmAction({ title: `Delete “${taskTitle(t)}”?`, body: `${typeof whenMain === 'string' ? whenMain : t.trigger.cron}${typeof whenSub === 'string' ? `, ${whenSub.toLowerCase()}` : ''}.`, confirm: 'Delete task', tone: 'danger', icon: 'delete' })) await taskAction('DELETE', t);
              }, true, true)));
        })
      : [emptyRow(6, el('b', {}, 'No tasks yet. '), 'A nightly restart at 04:00 and a backup at 04:30 keep the server fresh and recoverable. Press New task and start from one of the ready-made ones.')]));
  } catch (e) {
    $('task-list').replaceChildren(emptyRow(6, `Can't load tasks: ${e.message}`));
  }
}
tabLoaders.automation = loadTasks;
$('task-new').addEventListener('click', () => openTaskForm(null));

function taskButton(label, iconName, fn, danger, iconOnly) {
  const btn = iconOnly
    ? el('button', { class: `btn btn-quiet btn-sm btn-icon${danger ? ' danger' : ''}`, 'aria-label': label, title: label }, icon(iconName))
    : el('button', { class: `btn btn-quiet btn-sm${danger ? ' danger' : ''}` }, icon(iconName), label);
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
  const label = taskTitle(task);
  const hasCountdown = task.steps.find((st) => st.type === 'restart' || st.type === 'stop');
  const ok = await confirmAction({
    title: `Run “${label}” now?`,
    body: `${task.steps.map(describeStep).join(' → ')}${hasCountdown ? '. Players see the countdown in chat.' : '.'}`,
    confirm: 'Run now', tone: 'primary', icon: 'play',
  });
  if (!ok) return;
  try {
    await api('POST', `/api/tasks/${task.id}/run`);
    toast(`Started “${label}”.`);
  } catch (e) {
    toast(e.message, 'bad');
  }
  setTimeout(loadTasks, 1000);
  refreshStatus(true);
}

// --- the task form ---

const taskForm = $('task-form');
let taskSteps = [];
let taskTrigger = 'time';

const PRESETS = {
  nightly: { name: 'Nightly restart', trigger: { type: 'time', time: '04:00', days: [] }, steps: [{ type: 'restart', warnSeconds: 300 }] },
  'backup-restart': { name: 'Backup and restart', trigger: { type: 'time', time: '04:00', days: [] }, steps: [{ type: 'say', message: 'Backup and restart in 5 minutes' }, { type: 'backup' }, { type: 'restart', warnSeconds: 300 }] },
  'empty-restart': { name: 'Restart when empty', trigger: { type: 'event', event: 'empty', minutes: 30, cooldownMinutes: 360 }, steps: [{ type: 'if-empty' }, { type: 'restart', warnSeconds: 0 }] },
  'crash-start': { name: 'Start after a crash', trigger: { type: 'event', event: 'crash', cooldownMinutes: 10 }, steps: [{ type: 'wait', seconds: 30 }, { type: 'start' }] },
  'hourly-backup': { name: 'Backup every 2 hours', trigger: { type: 'cron', cron: '0 */2 * * *' }, steps: [{ type: 'backup' }] },
};
const STEP_DEFAULTS = { say: { message: '' }, command: { command: '' }, wait: { seconds: 60 }, restart: { warnSeconds: 300 }, stop: { warnSeconds: 300 } };

function setTrigger(type) {
  taskTrigger = type;
  $('task-trigger').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.trigger === type)));
  syncTaskForm();
}
$('task-trigger').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-trigger]');
  if (b) setTrigger(b.dataset.trigger);
});

function syncTaskForm() {
  const ev = taskForm.elements.event.value;
  taskForm.querySelectorAll('[data-trigger-for]').forEach((l) => {
    l.hidden = l.dataset.triggerFor !== taskTrigger || (l.dataset.eventFor && l.dataset.eventFor !== ev);
  });
  if (taskTrigger === 'cron') previewCron();
}
taskForm.elements.event.addEventListener('change', syncTaskForm);
// "Every day" and single days exclude each other; no day picked means every day.
taskForm.querySelector('.days').addEventListener('change', (e) => {
  const all = taskForm.querySelector('.days input[value=all]');
  const days = [...taskForm.querySelectorAll('.days input:not([value=all])')];
  if (e.target === all) days.forEach((d) => (d.checked = false));
  all.checked = !days.some((d) => d.checked);
});

let cronTimer = null;
function previewCron() {
  clearTimeout(cronTimer);
  const note = $('task-cron-note');
  const expr = taskForm.elements.cron.value.trim();
  if (!expr) {
    note.textContent = 'Minute, hour, day of month, month, weekday. Server time.';
    note.classList.remove('bad');
    return;
  }
  cronTimer = setTimeout(async () => {
    try {
      const { next } = await api('GET', `/api/tasks/preview?cron=${encodeURIComponent(expr)}`);
      note.textContent = next.length ? `Next: ${next.map((d) => fmt.date(d)).join(' · ')}` : 'This expression never runs.';
      note.classList.toggle('bad', !next.length);
    } catch (e) {
      note.textContent = e.message;
      note.classList.add('bad');
    }
  }, 300);
}
taskForm.elements.cron.addEventListener('input', previewCron);

function stepField(st, key, attrs, label) {
  const input = el('input', { class: `field${key === 'command' ? ' mono' : ''}`, value: st[key] ?? '', 'aria-label': label, ...attrs });
  input.addEventListener('input', () => (st[key] = attrs.type === 'number' ? Number(input.value) : input.value));
  return input;
}

function renderSteps() {
  const list = $('task-steps');
  list.replaceChildren(...taskSteps.map((st, i) => {
    const move = (d) => {
      const j = i + d;
      if (j < 0 || j >= taskSteps.length) return;
      [taskSteps[i], taskSteps[j]] = [taskSteps[j], taskSteps[i]];
      renderSteps();
    };
    const fields = [];
    if (st.type === 'say') fields.push(stepField(st, 'message', { placeholder: 'Restart in 5 minutes', maxlength: 200 }, 'Message'));
    if (st.type === 'command') fields.push(stepField(st, 'command', { placeholder: 'save-all', maxlength: 1000, spellcheck: 'false' }, 'Command'));
    if (st.type === 'wait') fields.push(stepField(st, 'seconds', { type: 'number', min: 1, max: 3600 }, 'Seconds'), el('span', { class: 'unit' }, 'seconds'));
    if (st.type === 'restart' || st.type === 'stop') fields.push(stepField(st, 'warnSeconds', { type: 'number', min: 0, max: 3600 }, 'Warning in seconds'), el('span', { class: 'unit' }, 's warning'));
    const btn = (label, iconName, fn, disabled) => {
      const b = el('button', { type: 'button', class: 'btn btn-quiet btn-icon btn-sm', 'aria-label': label, title: label, ...(disabled ? { disabled: '' } : {}) }, icon(iconName));
      b.addEventListener('click', fn);
      return b;
    };
    return el('li', { class: 'step' },
      el('span', { class: 'step-n' }, String(i + 1)),
      el('div', { class: 'step-main' }, el('span', { class: 'step-label' }, icon(STEP[st.type].icon), STEP[st.type].label), fields.length ? el('div', { class: 'step-fields' }, ...fields) : ''),
      el('div', { class: 'step-tools' },
        btn('Move up', 'chev', () => move(-1), i === 0),
        btn('Move down', 'chev', () => move(1), i === taskSteps.length - 1),
        btn('Remove step', 'remove', () => {
          taskSteps.splice(i, 1);
          renderSteps();
        })));
  }));
  if (!taskSteps.length) list.append(el('li', { class: 'steps-empty' }, 'No steps yet. Add the first one below.'));
}

$('task-step-add').addEventListener('click', () => {
  const type = $('task-step-type').value;
  taskSteps.push({ type, ...(STEP_DEFAULTS[type] || {}) });
  renderSteps();
  $('task-steps').lastElementChild?.querySelector('input')?.focus();
});

function fillTaskForm(t) {
  const f = taskForm.elements;
  f.name.value = t.name || '';
  const tr = t.trigger || { type: 'time', time: '04:00', days: [] };
  f.time.value = tr.time || '04:00';
  const days = tr.days || [];
  taskForm.querySelectorAll('.days input').forEach((i) => (i.checked = i.value === 'all' ? !days.length : days.includes(Number(i.value))));
  f.cron.value = tr.cron || '';
  f.event.value = tr.event || 'crash';
  f.minutes.value = tr.minutes ?? 30;
  f.match.value = tr.match || '';
  f.cooldownMinutes.value = tr.cooldownMinutes ?? 10;
  taskSteps = (t.steps || []).map((st) => ({ ...st }));
  setTrigger(tr.type);
  renderSteps();
}

function openTaskForm(task) {
  editingTask = task?.id || null;
  const f = taskForm.elements;
  f.server.replaceChildren(...taskMeta.servers.map((x) => el('option', { value: x.id ?? '' }, `${serverLabel(x.id)}${x.id === taskMeta.shown ? ' (shown)' : ''}${x.kind === 'proxy' ? ' · proxy' : ''}`)));
  f.event.replaceChildren(...Object.keys(EVENT_LABEL).map((k) => el('option', { value: k }, EVENT_LABEL[k])));
  f.server.value = String((task ? task.server : taskMeta.shown) ?? '');
  f.server.disabled = taskMeta.servers.length < 2;
  $('task-preset-fld').hidden = Boolean(task);
  f.preset.value = '';
  $('drawer-task-title').textContent = task ? 'Edit task' : 'New task';
  $('task-save').replaceChildren(icon(task ? 'check' : 'add'), task ? 'Save task' : 'Add task');
  $('task-error').textContent = '';
  fillTaskForm(task || { trigger: { type: 'time', time: '04:00', days: [] }, steps: [] });
  openDrawer('drawer-task', task ? f.name : f.preset);
}
const editTask = (t) => openTaskForm(t);

taskForm.elements.preset.addEventListener('change', () => {
  const p = PRESETS[taskForm.elements.preset.value];
  if (!p) {
    fillTaskForm({ trigger: { type: taskTrigger, time: taskForm.elements.time.value }, steps: [] });
    return;
  }
  fillTaskForm(p);
  taskForm.elements.name.value = p.name;
});

function taskBody() {
  const f = taskForm.elements;
  const trigger = taskTrigger === 'time'
    ? { type: 'time', time: f.time.value, days: [...taskForm.querySelectorAll('.days input:checked')].filter((i) => i.value !== 'all').map((i) => Number(i.value)) }
    : taskTrigger === 'cron'
      ? { type: 'cron', cron: f.cron.value }
      : { type: 'event', event: f.event.value, minutes: Number(f.minutes.value), match: f.match.value, cooldownMinutes: Number(f.cooldownMinutes.value) };
  return { name: f.name.value, server: f.server.value === '' ? null : f.server.value, trigger, steps: taskSteps };
}

taskForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = taskBody();
  await busy($('task-save'), async () => {
    try {
      const saved = editingTask ? await api('PATCH', `/api/tasks/${editingTask}`, body) : await api('POST', '/api/tasks', body);
      $('task-error').textContent = '';
      closeDrawer('drawer-task');
      const [main, sub] = describeTrigger(saved.trigger);
      toast(`${editingTask ? 'Saved' : 'Added'} “${taskTitle(saved)}”: ${typeof main === 'string' ? main : saved.trigger.cron}${typeof sub === 'string' && saved.trigger.type === 'time' ? `, ${sub.toLowerCase()}` : ''}.`);
      await loadTasks();
    } catch (err) {
      $('task-error').textContent = err.message;
    }
  });
});

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

const updRollback = document.getElementById('upd-rollback'); // moves between the options and the last update's note
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
  // Roll back sits next to the update it undoes.
  const rb = updRollback;
  if (st.finishedAt && !st.error && !st.running) $('upd-status').append(rb);
  else if (rb.parentElement !== document.querySelector('.update-options')) document.querySelector('.update-options').append(rb);
  document.querySelectorAll('[data-update]').forEach((b) => (b.disabled = st.running));
  updRollback.disabled = st.running;
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
    body: `${opts.body ? `${opts.body}\n\n` : ''}Players are warned now; in ${restart} everyone is disconnected and the server stops. ${backup ? 'The world is backed up while nobody plays, then the' : 'The'} new jar goes in and the server starts again.`,
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
  try {
    const o = await api('GET', `/api/updates${refresh ? '?refresh' : ''}`);
    renderServerSummary(o);
    updatesLoaded = true;
    const name = o.platform?.name || 'Server';
    $('upd-builds').closest('.panel').hidden = !o.supported || !o.newerBuilds.length;
    $('upd-versions').closest('.panel').hidden = !o.supported || !o.newerVersions.length;
    document.querySelector('.update-options').hidden = !o.supported && !o.canRollback;
    $('upd-backup').closest('label').hidden = !o.supported;
    $('upd-current').textContent = o.current ? `${name} ${o.current.version}${o.current.build ? ` · build ${o.current.build}` : o.platform?.loaderVersion ? ` · loader ${o.platform.loaderVersion}` : ''}` : name;
    if (!o.supported) {
      $('upd-channel').hidden = true;
      $('upd-source').textContent = `rconsole updates Paper and Folia automatically. Update ${name} by hand (new server jar or loader), then restart here.`;
      updRollback.hidden = !o.canRollback;
      renderUpdateState(o.state);
      return;
    }
    $('upd-source').textContent = o.error ? `Can't reach PaperMC: ${o.error}` : o.current ? '' : 'Start the server once so its version shows in the log.';
    const latest = o.current && !o.newerBuilds.length;
    $('upd-channel').hidden = !o.current;
    $('upd-channel').className = `pill ${latest ? 'ok' : 'own'}`;
    $('upd-channel').replaceChildren(icon(latest ? 'check' : 'updates'), latest ? 'Latest build' : `${o.newerBuilds.length} update${o.newerBuilds.length === 1 ? '' : 's'} available`);
    updRollback.hidden = !o.canRollback;
    renderUpdateState(o.state);

    $('upd-builds').replaceChildren(...(o.newerBuilds.length
      ? o.newerBuilds.map((b, i) => el('tr', {},
          el('td', { class: 'primary-cell', 'data-label': 'Build' }, `#${b.id}`, i === 0 ? el('span', { class: 'sub' }, 'Newest') : null),
          el('td', { 'data-label': 'Channel' }, el('span', { class: `pill ${b.channel === 'STABLE' ? 'own' : ''}` }, (b.channel || 'unknown').toLowerCase())),
          el('td', { 'data-label': 'Released' }, when(b.time)),
          el('td', { class: 'act' }, el('button', {
            class: `btn btn-sm ${i === 0 ? 'btn-primary' : ''}`, 'data-update': true, disabled: updateBusy || undefined,
            onclick: () => startUpdate({ version: o.current.version, build: b.id }, { title: `Update to build ${b.id}?`, body: `${name} ${o.current.version} #${o.current.build} → #${b.id} (${(b.channel || '').toLowerCase()}). The previous jar is kept for rollback.`, confirm: 'Update', icon: 'updates' }),
          }, icon('updates'), 'Update'))))
      : [emptyRow(4, o.current ? [el('b', {}, 'You are on the latest build. '), `${name} ${o.current.version} #${o.current.build}.`] : 'No version information yet.')]));

    $('upd-versions').replaceChildren(...(o.newerVersions.length
      ? o.newerVersions.map((v) => el('tr', {},
          el('td', { class: 'primary-cell', 'data-label': 'Version' }, `Minecraft ${v}`),
          el('td', { class: 'act' }, el('button', { class: 'btn btn-sm', 'data-update': true, disabled: updateBusy || undefined, onclick: (e) => upgradeVersion(v, e.currentTarget) }, icon('updates'), 'Upgrade…'))))
      : [emptyRow(2, o.current ? `Minecraft ${o.current.version} is the newest version ${name} supports.` : '–')]));
    return { updates: o.newerBuilds.length, error: o.error };
  } catch (e) {
    $('upd-source').textContent = e.message;
    summaryRow('server', { state: ['bad', 'alert', "Couldn't check"] });
    return { error: e.message };
  }
}

// "Options": bring the server-software panel into view, mark it and put the
// focus on its first option, so the jump is visible even when it's on screen.
function showUpdateOptions() {
  const panel = $('upd-server');
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  panel.classList.remove('flash');
  void panel.offsetWidth;
  panel.classList.add('flash');
  const first = panel.querySelector('.update-options input:not([hidden]), .update-options select, .update-options button:not([hidden])');
  first?.focus({ preventScroll: true });
}

// One overview row per component: what is installed, its state, one action.
function summaryRow(key, { version, state, action }) {
  if (version !== undefined) $(`sum-${key}-ver`).textContent = version;
  const [tone, ic, text] = state;
  $(`sum-${key}-state`).replaceChildren(el('span', { class: `pill ${tone}` }, icon(ic), text));
  $(`sum-${key}-act`).replaceChildren(...(action ? [action] : []));
}

function renderServerSummary(o) {
  const name = o.platform?.name || 'Server software';
  $('sum-server-name').textContent = name;
  const version = o.current ? `${o.current.version}${o.current.build ? ` · build ${o.current.build}` : ''}` : 'Version not known yet';
  const details = el('button', { class: 'btn btn-sm', onclick: showUpdateOptions }, 'Options');
  if (!o.supported) return summaryRow('server', { version, state: ['', 'settings', 'Updated by hand'], action: details });
  if (o.error) return summaryRow('server', { version, state: ['bad', 'alert', "Can't reach PaperMC"], action: details });
  const newest = o.newerBuilds[0];
  if (!newest) return summaryRow('server', { version, state: ['ok', 'check', 'Up to date'], action: details });
  summaryRow('server', {
    version,
    state: ['own', 'updates', `Build ${newest.id} available`],
    action: el('button', { class: 'btn btn-sm btn-primary', 'data-update': true, disabled: updateBusy || undefined,
      onclick: () => startUpdate({ version: o.current.version, build: newest.id }, { title: `Update to build ${newest.id}?`, body: `${name} ${o.current.version} #${o.current.build} → #${newest.id}. The previous jar is kept for rollback.`, confirm: 'Update', icon: 'updates' }) },
      icon('updates'), 'Update'),
  });
}

async function loadPluginSummary(refresh) {
  try {
    const o = await api('GET', `/api/plugins${refresh ? '?refresh' : ''}`);
    $('sum-plugins').hidden = !o.addons; // vanilla: no plugins or mods
    if (!o.addons) return {};
    const label = o.addons.dir === 'mods' ? 'Mods' : 'Plugins';
    $('sum-plugins-name').textContent = label;
    const n = o.plugins.filter((p) => p.update).length;
    const version = `${o.plugins.length} installed`;
    const review = el('button', { class: 'btn btn-sm', onclick: () => showTab('server/plugins') }, n ? 'Review' : 'Manage');
    if (o.remoteError) summaryRow('plugins', { version, state: ['bad', 'alert', "Can't reach Modrinth"], action: review });
    else summaryRow('plugins', { version, state: n ? ['own', 'updates', `${n} update${n === 1 ? '' : 's'} available`] : ['ok', 'check', 'Up to date'], action: review });
    return { updates: n, error: o.remoteError };
  } catch (e) {
    summaryRow('plugins', { state: ['bad', 'alert', "Couldn't check"] });
    return { error: e.message };
  }
}

// The one "Check for updates": rconsole, server software and plugins at once.
async function checkAll(refresh) {
  const btn = $('upd-check');
  btn.setAttribute('aria-busy', 'true');
  try {
    const [self, server, addons] = await Promise.all([loadSelfUpdate(refresh), loadUpdates(refresh), loadPluginSummary(refresh)]);
    $('upd-checked').textContent = `Checked at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. rconsole also checks on its own every 6 hours.`;
    if (!refresh) return;
    const errors = [self, server, addons].filter((x) => x?.error).length;
    const due = [['rconsole', self], [$('sum-server-name').textContent, server], [$('sum-plugins-name').textContent.toLowerCase(), addons]].filter(([, x]) => x?.updates).map(([name]) => name);
    const list = due.length > 1 ? `${due.slice(0, -1).join(', ')} and ${due.at(-1)}` : due[0];
    toast(errors ? `Checked, but ${errors} source${errors === 1 ? '' : 's'} could not be reached.` : due.length ? `Updates available for ${list}.` : 'Everything is up to date.', errors ? 'bad' : 'ok');
  } finally {
    btn.removeAttribute('aria-busy');
  }
}
viewLoaders['server/updates'] = () => checkAll(false);
// ---------------------------------------------------------------------------
// rconsole's own updates
// ---------------------------------------------------------------------------

let selfWasRunning = false;
let selfVersion = null;
let selfLast = null; // last /api/self-update
let selfWatching = false;
let selfReloading = false;

// Steps bin/self-update.sh reports (step, plan, steps in its status file),
// plus "online": rconsole answering again. Older scripts report only a
// message; their steps are read from it.
const SELF_STEPS = {
  fetch: 'Download the update',
  node: (n) => `Install Node.js ${n || ''}`.trim(),
  check: 'Check the new version',
  files: 'Update system files',
  restart: 'Restart rconsole',
  online: 'Back online',
};
const selfStepFromMessage = (m = '') => (/^Fetching/.test(m) ? 'fetch' : /^Installing Node/.test(m) ? 'node' : /^Checking/.test(m) ? 'check' : /^(Updating system|Installing unit)/.test(m) ? 'files' : /^Restarting/.test(m) ? 'restart' : null);
const selfNeed = (u) => u?.node || u?.message?.match(/Installing Node\.js (\d+)/)?.[1] || '';

// This browser's update run, so the page can pick up where it was after
// rconsole restarts and the page reloads: what it was updating to, and
// whether a second run for Node.js should follow on its own.
const selfRun = {
  get() { try { return JSON.parse(sessionStorage.getItem('rconsole-self-run')) || null; } catch { return null; } },
  set(v) { try { v ? sessionStorage.setItem('rconsole-self-run', JSON.stringify(v)) : sessionStorage.removeItem('rconsole-self-run'); } catch {} },
};
const selfDismissed = (u) => { try { return localStorage.getItem('rconsole-self-dismissed') === u?.at; } catch { return false; } };

function renderSelfSummary(self) {
  if (!self) return;
  if (selfVersion && self.current && self.current !== selfVersion && !self.running) selfReload(self.current);
  selfVersion = self.current || selfVersion;
  $('rail-ver').textContent = self.current ? self.current : '';
  $('rail-update').hidden = !self.available && !self.running;
  document.querySelector('.nav [data-tab=server]').classList.toggle('has-update', Boolean(self.available));
  if (!selfWatching) $('rail-update-text').textContent = self.running ? 'Updating rconsole…' : `${self.available} update${self.available === 1 ? '' : 's'} for rconsole`;
  if (self.running && !selfWatching) watchSelfUpdate();
  // The update's state shows in Server → Updates.
  if (selfWasRunning && !self.running && document.body.dataset.area === 'server') loadSelfUpdate();
  selfWasRunning = self.running;
}

// A new version is serving; reload to get its frontend. The update card
// shows the result again after the reload.
function selfReload(sha) {
  if (selfReloading) return;
  selfReloading = true;
  toast(`rconsole updated to ${sha}. Reloading…`);
  setTimeout(() => location.reload(), 1200);
}

// The progress list: done steps with how long they took, the running one
// with the updater's message, then what is still to come.
function renderSelfSteps(u, { offline = false, next = null } = {}) {
  const seen = u.steps?.length ? u.steps : [];
  const current = offline ? 'restart' : u.state === 'done' ? 'online' : u.step && u.step !== 'done' ? u.step : selfStepFromMessage(u.message) || 'fetch';
  let plan = u.plan?.length ? [...u.plan] : ['fetch', 'check', 'files', 'restart'];
  if ((selfNeed(u) || seen.some((s) => s.step === 'node') || current === 'node') && !plan.includes('node')) plan.splice(1, 0, 'node');
  if (!plan.includes(current) && current !== 'online') plan.push(current);
  plan = [...plan, 'online'];
  const at = Object.fromEntries(seen.map((s, i) => [s.step, { at: s.at, end: seen[i + 1]?.at || (u.state !== 'running' ? u.at : null) }]));
  const idx = plan.indexOf(current);
  const secs = (a, b) => Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));
  const took = (s) => (s < 1 ? 'under 1 s' : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);
  const items = plan.map((key, i) => {
    const label = key === 'node' ? SELF_STEPS.node(selfNeed(u)) : SELF_STEPS[key];
    let state = i < idx || u.state === 'done' ? 'done' : i === idx ? 'active' : 'todo';
    if (u.state === 'failed' && i === idx) state = 'failed';
    if (u.state === 'failed' && i > idx) state = 'skipped';
    let detail = '';
    if (state === 'active') detail = offline ? 'Waiting for rconsole to come back…' : key === 'online' ? '' : `${u.message}…`;
    else if (state === 'failed') detail = 'Failed';
    else if (state === 'done' && at[key]?.end) detail = took(secs(at[key].at, at[key].end));
    if (state === 'active' && at[key]?.at) detail += ` ${took(secs(at[key].at, new Date().toISOString()))}`;
    const mark = state === 'done' ? icon('check') : state === 'failed' ? icon('alert') : el('span', {}, String(i + 1));
    return el('li', { 'data-state': state }, el('span', { class: 'step-mark' }, mark), el('span', { class: 'step-label' }, label), el('span', { class: 'step-detail' }, detail.trim()));
  });
  if (next) items.push(el('li', { 'data-state': next.auto ? 'active' : 'todo' }, el('span', { class: 'step-mark' }, el('span', {}, String(items.length + 1))),
    el('span', { class: 'step-label' }, SELF_STEPS.node(next.need)), el('span', { class: 'step-detail' }, next.auto ? 'Starting…' : 'This version needs it. Update once more to install it.')));
  $('self-steps').replaceChildren(...items);
  $('self-steps').hidden = false;
}

function renderChangelog(commits, repo) {
  $('self-changes').replaceChildren(...(commits || []).map((x) => {
    const title = el('span', { class: 'cl-title' }, x.message,
      x.version ? el('a', { class: 'pill own cl-ver', href: `https://github.com/${repo}/releases/tag/v${x.version}`, target: '_blank', rel: 'noopener', title: 'Release notes' }, x.version) : null);
    return el('li', {},
      el('a', { class: 'mono', href: `https://github.com/${repo}/commit/${x.sha}`, target: '_blank', rel: 'noopener' }, x.sha),
      x.body ? el('details', {}, el('summary', {}, title), el('p', { class: 'cl-body' }, x.body)) : title,
      x.date ? el('span', { class: 'note' }, fmt.relative(x.date)) : el('span'));
  }));
  $('self-changes').hidden = !commits?.length;
}

async function loadSelfUpdate(refresh) {
  try {
    const o = await api('GET', `/api/self-update${refresh ? '?refresh' : ''}`);
    renderSelf(o);
    const c = o.check || {};
    return { updates: c.status === 'ahead' ? c.behind : 0, error: c.error && !c.status ? c.error : null };
  } catch (e) {
    $('self-info').textContent = e.message;
    $('self-panel').hidden = false;
    summaryRow('self', { state: ['bad', 'alert', "Couldn't check"] });
    return { error: e.message };
  }
}

function renderSelf(o, { offline = false } = {}) {
  selfLast = o;
  const c = o.check || {};
  const run = selfRun.get();
  const behind = c.status === 'ahead' ? c.behind : 0;
  // Too old a Node.js: Update installs the right one even with no new commits.
  const nodeOld = o.node && !o.node.ok ? o.node : null;
  // Only a status about the installed version is news: a finished update
  // must have ended on it, a failed one must have started from it.
  const cur = o.current?.sha || '';
  const u = o.update && cur && (o.update.state === 'running' || String(o.update.state === 'done' ? o.update.to : o.update.from).startsWith(cur)) ? o.update : null;
  const running = u?.state === 'running' || offline;
  const recent = (ms) => u && Date.now() - Date.parse(u.at) < ms;
  // A finished update stays on the page for an hour (or until dismissed):
  // its steps and what it brought in, so the result doesn't vanish with
  // the reload.
  const justDone = u?.state === 'done' && (u.from !== u.to || u.installed?.length) && recent(3600000) && !selfDismissed(u);
  const failed = u?.state === 'failed' && recent(7 * 86400000);
  const repo = o.repo;
  const version = o.current?.version;

  $('self-info').textContent = [
    c.error ? `Can't check github.com/${repo}: ${c.error}` : '',
    nodeOld && !running && !justDone ? `rconsole needs Node.js ${nodeOld.need} or newer and runs on ${nodeOld.version}. Update installs Node.js ${nodeOld.need} from NodeSource and restarts rconsole.` : '',
  ].filter(Boolean).join(' ');

  // Second run for Node.js: the update to 4.7 ran with the old updater,
  // which doesn't install it. Started on its own if this browser started
  // the first run.
  const next = justDone && nodeOld ? { need: nodeOld.need, auto: Boolean(run?.auto && o.canUpdate) } : null;

  if (running) {
    const target = run?.version && run.version !== version ? ` to ${run.version}` : '';
    $('self-title').textContent = `Updating rconsole${target}`;
    renderSelfSteps(u || { state: 'running', message: 'Restarting rconsole', step: 'restart' }, { offline });
  } else if (justDone) {
    $('self-title').textContent = u.from === u.to ? `Installed Node.js for rconsole` : `Updated rconsole${version ? ` to ${version}` : ''}`;
    renderSelfSteps(u, { next });
  } else if (failed && recent(3600000)) {
    $('self-title').textContent = 'The rconsole update failed';
    renderSelfSteps(u);
  } else {
    $('self-title').textContent = behind ? (c.version && c.version !== version ? `rconsole ${c.version} is available` : `${behind} new commit${behind === 1 ? '' : 's'} for rconsole`) : nodeOld ? `rconsole needs Node.js ${nodeOld.need}` : "What's new in rconsole";
    $('self-steps').hidden = true;
  }

  // A Node.js-only run already says what it installed.
  const also = (u?.installed || []).filter((x) => !(u.from === u.to && /^Node\.js/.test(x)));
  if (failed && !running) setJob($('self-status'), 'failed', 'alert', `Last update failed ${fmt.relative(u.at)}: ${u.message}`);
  else if (justDone && u.manual?.length) setJob($('self-status'), 'done', 'check', `Manual step: ${u.manual.join('; ')}`);
  else if (justDone && also.length) setJob($('self-status'), 'done', 'check', `${u.message} ${fmt.relative(u.at)}. Also installed: ${also.join(', ')}.`);
  else if (justDone) setJob($('self-status'), 'done', 'check', `${u.message} ${fmt.relative(u.at)}.`);
  else setJob($('self-status'), null);

  // What the update brings in: from GitHub before, kept for the run while
  // rconsole restarts, and what the finished update brought in after.
  const commits = running ? (run?.commits || c.commits) : justDone ? (u.commits || run?.commits) : behind ? c.commits : null;
  renderChangelog(commits, repo);
  const more = behind > (c.commits?.length || 0) && !running && !justDone ? behind - c.commits.length : 0;
  $('self-changes-title').textContent = running ? 'What this update brings' : justDone ? 'What changed' : `Changes${more ? ` (newest 30 of ${behind})` : ''}`;
  $('self-changes-title').hidden = $('self-changes').hidden;

  $('self-note').hidden = !(behind || nodeOld) || running || justDone;
  $('self-update').hidden = !(behind || nodeOld) || running || !o.canUpdate || Boolean(next?.auto);
  $('self-update').disabled = !o.canUpdate || running;
  $('self-update').replaceChildren(icon('updates'), next ? `Install Node.js ${next.need}` : behind ? 'Update rconsole' : `Install Node.js ${nodeOld?.need || ''}`);
  $('self-dismiss').hidden = !justDone || running;
  $('self-panel').hidden = !behind && !nodeOld && !running && !justDone && !failed && !(c.error && !c.status);

  const updatedAgo = u?.state === 'done' && u.from !== u.to && recent(86400000) ? ` · updated ${fmt.relative(u.at)}` : '';
  summaryRow('self', {
    version: o.current ? `${version ? `${version} · ` : ''}${o.current.sha}${o.current.branch ? ` on ${o.current.branch}` : ''}${updatedAgo}` : 'Unknown version',
    state: running ? ['own', 'updates', 'Updating…'] : nodeOld ? ['own', 'updates', `Needs Node.js ${nodeOld.need}`] : c.error && !c.status ? ['bad', 'alert', "Can't reach GitHub"] : behind ? ['own', 'updates', `${behind} new commit${behind === 1 ? '' : 's'}`] : justDone ? ['ok', 'check', 'Updated'] : c.status === 'diverged' ? ['', 'alert', 'Diverged from GitHub'] : ['ok', 'check', 'Up to date'],
    action: (behind || nodeOld) && o.canUpdate && !running
      ? el('button', { class: 'btn btn-sm btn-primary', onclick: () => $('self-update').click() }, icon('updates'), 'Update')
      : el('a', { class: 'btn btn-sm', href: running || justDone ? '#server/updates' : `https://github.com/${repo}/commits/${o.branch}`, target: running || justDone ? undefined : '_blank', rel: 'noopener', onclick: running || justDone ? (e) => { e.preventDefault(); $('self-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); } : undefined }, running || justDone ? 'Details' : 'Changes'),
  });

  if (next?.auto && !running) {
    selfRun.set({ ...run, auto: false });
    toast(`Step 2: installing Node.js ${next.need}`);
    startSelfUpdate();
  }
  if (running && !selfWatching) watchSelfUpdate();
  if (!running && run && !next?.auto) selfRun.set(null);
}

async function startSelfUpdate() {
  try {
    await api('POST', '/api/self-update');
  } catch (err) {
    toast(err.message, 'bad');
    loadSelfUpdate();
    return;
  }
  const o = selfLast;
  if (o) {
    o.update = { state: 'running', message: 'Starting the updater', step: 'fetch', plan: o.check?.status === 'ahead' ? null : ['fetch', 'node', 'restart'], node: o.node?.ok ? '' : String(o.node?.need || ''), from: '', at: new Date().toISOString() };
    renderSelf(o);
  }
  watchSelfUpdate();
}

$('self-update').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const o = selfLast || {};
  const c = o.check || {};
  const nodeOnly = c.status !== 'ahead';
  if (!(await confirmAction({
    title: nodeOnly ? `Install Node.js ${o.node?.need || ''}?` : `Update rconsole${c.version && c.version !== o.current?.version ? ` to ${c.version}` : ''}?`,
    body: `rconsole restarts${nodeOnly ? ' on the new Node.js' : ''}; you stay signed in and this page shows each step. If it doesn't come back, it rolls back on its own. Minecraft is not affected.`,
    confirm: nodeOnly ? 'Install' : 'Update rconsole', icon: 'updates',
  }))) return;
  // The run started from an old Node.js needs a second one (see renderSelf).
  selfRun.set({ version: c.version || null, commits: c.commits || null, auto: true });
  await busy(btn, startSelfUpdate);
});

$('self-dismiss').addEventListener('click', () => {
  try { localStorage.setItem('rconsole-self-dismissed', selfLast?.update?.at || ''); } catch {}
  selfRun.set(null);
  if (selfLast) renderSelf(selfLast);
});

// While an update runs: its status every 1.5 s. While rconsole restarts the
// requests fail, which is the "restart" step; once it answers on a new
// commit, reload for the new frontend.
function watchSelfUpdate() {
  if (selfWatching) return;
  selfWatching = true;
  const startSha = selfLast?.current?.sha || selfVersion;
  const started = Date.now();
  const tick = async () => {
    let o = null;
    try {
      const res = await fetch('/api/self-update', { cache: 'no-store' });
      if (res.status === 401) return location.replace('/login');
      if (res.ok) o = await res.json();
    } catch {}
    const offline = !o;
    if (o) renderSelf(o);
    else if (selfLast) renderSelf(selfLast, { offline: true });
    const u = o?.update;
    const step = offline ? 'Restarting rconsole' : u?.state === 'running' ? u.message : null;
    if (step) $('rail-update-text').textContent = `Updating: ${step.replace(/\s*\(.*\)$/, '')}…`;
    $('rail-update').hidden = false;
    const moved = o?.current?.sha && startSha && o.current.sha !== startSha;
    if (o && u?.state !== 'running' && moved) {
      selfWatching = false;
      return selfReload(o.current.sha);
    }
    if ((o && u?.state !== 'running') || Date.now() - started > 20 * 60 * 1000) {
      selfWatching = false;
      $('rail-update').hidden = !(o?.check?.status === 'ahead');
      return;
    }
    setTimeout(tick, 1500);
  };
  setTimeout(tick, 1000);
}

// While rconsole restarts, requests fail; poll /healthz, then sign back in.
function waitForComeback() {
  let sawDown = false;
  const started = Date.now();
  const poll = async () => {
    const ok = await fetch('/healthz', { cache: 'no-store' }).then((r) => r.ok).catch(() => false);
    if (!ok) sawDown = true;
    if ((ok && sawDown) || Date.now() - started > 5 * 60 * 1000) return location.reload();
    setTimeout(poll, 1500);
  };
  setTimeout(poll, 1500);
}


async function upgradeVersion(version, btn) {
  try {
    const { builds } = await busy(btn, () => api('GET', `/api/updates/builds?version=${encodeURIComponent(version)}`));
    // Vanilla has no builds: the version is the download.
    const b = builds[0] || { id: null, channel: '' };
    startUpdate({ version, build: b.id }, {
      title: `Upgrade to Minecraft ${version}?`,
      body: `${b.id == null ? 'The server' : `Build ${b.id}${b.channel ? ` (${b.channel.toLowerCase()})` : ''}`}. This converts the world to ${version}. Rolling back the jar afterwards does not undo that; only restoring the backup does.`,
      confirm: 'Upgrade',
      tone: 'danger',
      icon: 'updates',
    });
  } catch (e) {
    toast(e.message, 'bad');
  }
}

$('upd-check').addEventListener('click', () => checkAll(true));
updRollback.addEventListener('click', () => startUpdate({ rollback: true }, { title: 'Roll back to the previous jar?', body: 'Swaps the server jar back to the one before the last update.', confirm: 'Roll back', tone: 'primary', icon: 'rollback' }));

// ---------------------------------------------------------------------------
// Charts (inline SVG, drawn at the container's real width)
// ---------------------------------------------------------------------------

function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  // Divisible by the four grid steps into round labels (1.5h, not 1.3h).
  return [1, 2, 4, 6, 8, 10].map((m) => m * p).find((m) => m >= v);
}

const timeLabel = (ms, span) => new Date(ms).toLocaleString(undefined, span > 2 * 86400000 ? { weekday: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

const charts = new Map(); // box -> { draw, data }
const chartObserver = new ResizeObserver((entries) => {
  for (const e of entries) {
    const c = charts.get(e.target);
    if (c && Math.abs(e.contentRect.width - (c.width || 0)) > 4) c.draw();
  }
});

function chartTip(box) {
  let tip = box.querySelector('.chart-tip');
  if (!tip) {
    tip = el('div', { class: 'chart-tip', hidden: true });
    box.append(tip);
  }
  return tip;
}

// o: { t: [ms], from, to, step (s), series: [{ values, label, fmt, cls }], max, yFmt, up: [0|1] }
function lineChart(box, o) {
  const draw = () => {
    const W = box.clientWidth || 600;
    const H = o.height || 168;
    const L = 44, R = 10, T = 10, B = 24;
    charts.get(box).width = W;
    const drawn = o.series.filter((s) => !s.tipOnly); // tipOnly: in the tooltip, not drawn
    const all = drawn.flatMap((s) => s.values).filter((v) => v != null);
    const max = o.max ?? niceMax(Math.max(...all, o.minMax || 0));
    const x = (t) => L + ((t - o.from) / (o.to - o.from)) * (W - L - R);
    const y = (v) => T + (1 - Math.min(v, max) / max) * (H - T - B);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart-svg', role: 'img', 'aria-label': o.label });
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4;
      svg.append(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: i ? 'grid' : 'axis' }),
        svgEl('text', { x: L - 6, y: y(v) + 4, class: 'ylab' }, o.yFmt(v)));
    }
    const span = o.to - o.from;
    const ticks = W < 480 ? 3 : 5;
    for (let i = 0; i <= ticks; i++) {
      const t = o.from + (span * i) / ticks;
      svg.append(svgEl('text', { x: x(t), y: H - 6, class: `xlab${i === 0 ? ' first' : i === ticks ? ' last' : ''}` }, timeLabel(t, span)));
    }
    const gap = o.step * 2500;
    // Downtime: shade stretches where the server was down.
    if (o.up) {
      let start = null;
      o.t.forEach((t, i) => {
        if (o.up[i] === 0 && start == null) start = t;
        if ((o.up[i] !== 0 || i === o.t.length - 1) && start != null) {
          const end = o.up[i] === 0 ? t + o.step * 1000 : t;
          svg.append(svgEl('rect', { x: x(start), y: T, width: Math.max(2, x(end) - x(start)), height: H - T - B, class: 'down' }));
          start = null;
        }
      });
    }
    drawn.forEach((s, si) => {
      let d = '';
      let fill = '';
      let seg = [];
      const flush = () => {
        if (seg.length) fill += `M${seg[0][0]},${y(0)}L${seg.map((p) => p.join(',')).join('L')}L${seg[seg.length - 1][0]},${y(0)}Z`;
        seg = [];
      };
      o.t.forEach((t, i) => {
        const v = s.values[i];
        if (v == null || t < o.from || t > o.to) return flush(); // outside the range: never draw past the axes
        const pt = [x(t).toFixed(1), y(v).toFixed(1)];
        const prevT = o.t[i - 1];
        const broken = !seg.length || t - prevT > gap || s.values[i - 1] == null;
        if (broken) flush();
        d += `${broken ? 'M' : 'L'}${pt.join(',')}`;
        seg.push(pt);
      });
      flush();
      if (si === 0 && fill) svg.append(svgEl('path', { d: fill, class: 'fill' }));
      if (d) svg.append(svgEl('path', { d, class: `line ${s.cls || ''}` }));
    });
    const cursor = svgEl('line', { y1: T, y2: H - B, class: 'cursor', visibility: 'hidden' });
    const dots = drawn.map((s) => svgEl('circle', { r: 3.5, class: `dot ${s.cls || ''}`, visibility: 'hidden' }));
    svg.append(cursor, ...dots);
    const empty = !o.t.length ? svgEl('text', { x: (L + W - R) / 2, y: (T + H - B) / 2, class: 'empty' }, 'No samples yet') : null;
    if (empty) svg.append(empty);
    const tip = chartTip(box);
    svg.addEventListener('pointermove', (e) => {
      if (!o.t.length) return;
      const r = svg.getBoundingClientRect();
      const px = e.clientX - r.left;
      const t = o.from + ((px - L) / (W - L - R)) * span;
      let i = o.t.findIndex((v) => v >= t);
      if (i < 0) i = o.t.length - 1;
      if (i > 0 && t - o.t[i - 1] < o.t[i] - t) i--;
      const cx = x(o.t[i]);
      cursor.setAttribute('x1', cx);
      cursor.setAttribute('x2', cx);
      cursor.setAttribute('visibility', 'visible');
      drawn.forEach((s, si) => {
        const v = s.values[i];
        dots[si].setAttribute('visibility', v == null ? 'hidden' : 'visible');
        if (v != null) { dots[si].setAttribute('cx', cx); dots[si].setAttribute('cy', y(v)); }
      });
      tip.replaceChildren(el('b', {}, new Date(o.t[i]).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })),
        ...o.series.map((s) => el('span', { class: `tip-row ${s.cls || ''}` }, el('i'), `${s.label}: `, el('b', {}, s.values[i] == null ? '–' : s.fmt(s.values[i])))),
        ...(o.up && o.up[i] === 0 ? [el('span', { class: 'tip-row' }, 'Server down')] : []));
      tip.hidden = false;
      tip.style.left = `${Math.min(Math.max(cx, 80), W - 80)}px`;
    });
    svg.addEventListener('pointerleave', () => {
      tip.hidden = true;
      cursor.setAttribute('visibility', 'hidden');
      dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
    });
    box.querySelector('svg')?.remove();
    box.prepend(svg);
    if (drawn.length > 1 && !box.querySelector('.legend')) {
      box.append(el('div', { class: 'legend' }, ...drawn.map((s) => el('span', { class: s.cls || '' }, el('i'), s.label))));
    }
  };
  if (!charts.has(box)) chartObserver.observe(box);
  charts.set(box, { draw, width: 0 });
  draw();
}

function barChart(box, bars, { label, fmt: valueFmt, detail }) {
  const draw = () => {
    const W = box.clientWidth || 600;
    const H = 150;
    const L = 44, R = 10, T = 10, B = 24;
    charts.get(box).width = W;
    const max = niceMax(Math.max(...bars.map((b) => b.value), 0));
    const bw = (W - L - R) / Math.max(bars.length, 1);
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'chart-svg', role: 'img', 'aria-label': label });
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4;
      svg.append(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: i ? 'grid' : 'axis' }), svgEl('text', { x: L - 6, y: y(v) + 4, class: 'ylab' }, valueFmt(v)));
    }
    const tip = chartTip(box);
    bars.forEach((b, i) => {
      const bx = L + i * bw;
      if (i % Math.ceil(bars.length / 6) === 0) svg.append(svgEl('text', { x: bx + bw / 2, y: H - 6, class: 'xlab' }, b.label));
      const rect = svgEl('rect', { x: bx + bw * 0.15, width: bw * 0.7, y: y(b.value), height: Math.max(b.value ? 1.5 : 0, y(0) - y(b.value)), class: 'bar' });
      const hit = svgEl('rect', { x: bx, width: bw, y: T, height: H - T - B, class: 'hit' });
      hit.addEventListener('pointerenter', () => {
        tip.replaceChildren(el('b', {}, b.title), ...detail(b).map((d) => el('span', { class: 'tip-row' }, d)));
        tip.hidden = false;
        tip.style.left = `${Math.min(Math.max(bx + bw / 2, 80), W - 80)}px`;
        rect.classList.add('on');
      });
      hit.addEventListener('pointerleave', () => {
        tip.hidden = true;
        rect.classList.remove('on');
      });
      svg.append(rect, hit);
    });
    box.querySelector('svg')?.remove();
    box.prepend(svg);
  };
  if (!charts.has(box)) chartObserver.observe(box);
  charts.set(box, { draw, width: 0 });
  draw();
}

const statList = (id, items) => $(id).replaceChildren(...items.filter(Boolean).map(([k, v]) => el('div', {}, el('dt', {}, k), el('dd', {}, v))));
const nums = (a) => a.filter((v) => v != null);
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const lastOf = (a) => [...a].reverse().find((v) => v != null) ?? null;

// ---------------------------------------------------------------------------
// Insights: metrics
// ---------------------------------------------------------------------------

let metricsRange = '24h';

async function loadMetrics() {
  try {
    const m = await api('GET', `/api/metrics?range=${metricsRange}`);
    const base = { t: m.t, from: m.from, to: m.to, step: m.step, up: m.up };
    const pct = (v) => fmt.pct(v);
    const n = m.t.length;
    $('m-info').textContent = n
      ? `${n} sample${n === 1 ? '' : 's'}, ${m.step === 30 ? 'every 30 seconds' : '5-minute averages'}. Shaded: server down.`
      : 'Collecting. The first sample arrives within 30 seconds; history builds up from there.';
    const tps = nums(m.tps);
    lineChart($('mc-tps'), { ...base, label: 'TPS', max: 20, yFmt: (v) => String(Math.round(v)), series: [{ values: m.tps, label: 'TPS', fmt: (v) => v.toFixed(1) }] });
    statList('ms-tps', [['Now', lastOf(m.tps)?.toFixed(1) ?? '–'], ['Avg', avg(tps)?.toFixed(1) ?? '–'], ['Low', tps.length ? Math.min(...tps).toFixed(1) : '–']]);
    const pl = nums(m.players);
    lineChart($('mc-players'), { ...base, label: 'Players online', minMax: 4, yFmt: (v) => (Number.isInteger(v) ? String(v) : ''), series: [{ values: m.players, label: 'Players', fmt: String }] });
    statList('ms-players', [['Now', lastOf(m.players) ?? '–'], ['Peak', pl.length ? Math.max(...pl) : '–']]);
    lineChart($('mc-cpu'), { ...base, label: 'CPU', max: 1, yFmt: pct, series: [{ values: m.cpu, label: 'Host', fmt: pct }, { values: m.pcpu, label: 'Minecraft', fmt: pct, cls: 'alt' }] });
    statList('ms-cpu', [['Host', lastOf(m.cpu) != null ? pct(lastOf(m.cpu)) : '–'], ['Minecraft', lastOf(m.pcpu) != null ? pct(lastOf(m.pcpu)) : '–']]);
    const heapSeries = (m.heap || []).some((v) => v != null);
    lineChart($('mc-mem'), { ...base, label: 'Memory', max: 1, yFmt: pct, series: [
      ...(heapSeries ? [{ values: m.heap, label: 'Java heap in use', fmt: pct }] : []),
      { values: m.mem, label: 'Host used', fmt: pct },
    ] });
    statList('ms-mem', [
      ...(heapSeries ? [['Java heap', lastOf(m.heap) != null ? pct(lastOf(m.heap)) : '–']] : []),
      ['Host', lastOf(m.mem) != null ? pct(lastOf(m.mem)) : '–'],
      ['Minecraft RSS', lastOf(m.rss) != null ? fmt.bytes(lastOf(m.rss)) : '–'],
    ]);
  } catch (e) {
    $('m-info').textContent = `Can't load metrics: ${e.message}`;
  }
}
viewLoaders['insights/metrics'] = () => { loadMetrics(); loadSpark(); };

$('m-range').addEventListener('click', (e) => {
  const b = e.target.closest('[data-range]');
  if (!b) return;
  metricsRange = b.dataset.range;
  for (const x of $('m-range').querySelectorAll('[data-range]')) x.setAttribute('aria-checked', x === b);
  loadMetrics();
});
setInterval(() => {
  if (!document.hidden && document.body.dataset.area === 'insights' && currentView('insights') === 'metrics') loadMetrics();
}, 30000);

// ---------------------------------------------------------------------------
// Insights: log search
// ---------------------------------------------------------------------------

function highlight(text, needle) {
  if (!needle) return [text];
  const out = [];
  const low = text.toLowerCase();
  let i = 0;
  for (let j = low.indexOf(needle); j >= 0 && out.length < 40; j = low.indexOf(needle, i)) {
    out.push(text.slice(i, j), el('mark', {}, text.slice(j, j + needle.length)));
    i = j + needle.length;
  }
  out.push(text.slice(i));
  return out;
}

// Arriving at Logs shows the latest warnings and errors right away.
viewLoaders['insights/logs'] = () => {
  if (!$('ls-results').hidden) return;
  const f = $('ls-form').elements;
  if (f.q.value || f.player.value || f.level.value) return;
  f.level.value = 'WARN';
  searchLogsUi();
};

// "Oct 20 00:25:41": fixed width in every browser language, so the column
// never wraps (a German Safari wrote "20. Okt., 00:25:41" on two lines).
function logStamp(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.toLocaleString('en', { month: 'short' })} ${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function searchLogsUi() {
  const f = $('ls-form').elements;
  const params = new URLSearchParams();
  for (const k of ['q', 'player', 'level', 'from', 'to']) if (f[k].value.trim()) params.set(k, f[k].value.trim());
  if (![...params.keys()].some((k) => ['q', 'player', 'level'].includes(k))) {
    f.q.focus();
    return toast('Enter some text, a player or a level to search for.', 'bad');
  }
  const list = $('ls-results');
  await busy($('ls-form').querySelector('.btn-primary'), async () => {
    try {
      const r = await api('GET', `/api/logs/search?${params}`);
      const needle = f.q.value.trim().toLowerCase();
      list.hidden = false;
      list.replaceChildren(...(r.results.length
        ? r.results.map((x) => el('li', { class: `lvl-${x.level.toLowerCase()}` },
            el('time', { datetime: new Date(x.t).toISOString(), title: x.file }, logStamp(x.t)),
            el('span', { class: 'lvl' }, x.level),
            el('span', { class: 'msg' }, ...highlight(x.msg, needle))))
        : [el('li', { class: 'empty-state' }, 'No matching lines.')]));
      $('ls-info').textContent = `${r.results.length}${r.truncated ? '+' : ''} match${r.results.length === 1 ? '' : 'es'} in ${r.scanned} of ${r.files} log file${r.files === 1 ? '' : 's'}${r.truncated ? '. Showing the newest 500; narrow the search for more.' : r.timedOut ? '. Stopped early to keep the server responsive; narrow the dates for older logs.' : '.'}`;
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
}
$('ls-form').addEventListener('submit', (e) => {
  e.preventDefault();
  searchLogsUi();
});

// ---------------------------------------------------------------------------
// Server: files (the whole server folder; configs are the common case)
// ---------------------------------------------------------------------------

let cfgOpen = null; // { path, original, hasPrevious, sha256, protected }

// Line diff (LCS) as hunks with two lines of context; [type, text] pairs.
function diffLines(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) endA--, endB--;
  const a2 = A.slice(start, endA);
  const b2 = B.slice(start, endB);
  const ops = [];
  if (a2.length * b2.length > 4e6) {
    ops.push(...a2.map((l) => ['-', l]), ...b2.map((l) => ['+', l]));
  } else {
    const n = a2.length;
    const m = b2.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a2[i] === b2[j]) ops.push([' ', a2[i++]]), j++;
      else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) ops.push(['+', b2[j++]]);
      else ops.push(['-', a2[i++]]);
    }
  }
  const all = [...A.slice(0, start).map((l) => [' ', l]), ...ops, ...A.slice(endA).map((l) => [' ', l])];
  const keep = all.map((o, k) => o[0] !== ' ' || all.slice(Math.max(0, k - 2), k + 3).some((x) => x[0] !== ' '));
  const out = [];
  all.forEach((o, k) => {
    if (keep[k]) out.push(o);
    else if (out.length && out[out.length - 1][0] !== '…') out.push(['…', '']);
  });
  return out;
}

// Browsing: one folder at a time, folders first. The editor on the right
// opens text files; anything else gets its details and a download.
let fmDir = '';
let fmEntries = [];
let fmSelected = null; // { path, type, size, modified } of a non-text entry shown on the right
const fmJoin = (dir, name) => (dir ? `${dir}/${name}` : name);
const fmParent = (p) => p.split('/').slice(0, -1).join('/');
const FM_ICON = { dir: 'folder', file: 'file', link: 'copy', other: 'alert' };

function renderCrumbs() {
  const parts = fmDir ? fmDir.split('/') : [];
  const crumb = (label, to) => el('button', { class: 'fm-crumb', type: 'button', onclick: () => openFolder(to) }, label);
  $('fm-crumbs').replaceChildren(crumb(serverLabelShort(), ''), ...parts.flatMap((x, i) => [el('span', { class: 'fm-sep', 'aria-hidden': 'true' }, '/'), crumb(x, parts.slice(0, i + 1).join('/'))]));
}
const serverLabelShort = () => $('sw-name')?.textContent?.trim().replace(/^…$/, '') || 'Server folder';

function renderCfgList() {
  const q = $('cfg-filter').value.trim().toLowerCase();
  const shown = fmEntries.filter((e) => !q || e.name.toLowerCase().includes(q));
  const row = (e) => {
    const p = fmJoin(fmDir, e.name);
    const on = cfgOpen?.path === p || fmSelected?.path === p;
    return el('li', { class: 'fm-row' },
      el('button', { class: `cfg-file fm-entry${on ? ' on' : ''}${e.type === 'dir' ? ' is-dir' : ''}`, type: 'button', title: p, onclick: () => (e.type === 'dir' ? openFolder(p) : openConfig(p, e)) },
        icon(FM_ICON[e.type] || 'settings'),
        el('span', { class: 'fm-name' }, e.name),
        el('span', { class: 'fm-meta' }, e.type === 'dir' ? '' : e.type === 'file' ? fmt.bytes(e.size) : e.type)),
      e.type === 'link' || e.type === 'other' ? null : el('button', { class: 'btn btn-quiet btn-icon btn-sm fm-more', type: 'button', 'aria-label': `Actions for ${e.name}`, onclick: (ev) => fmMenu(ev.currentTarget, p, e) }, icon('more')));
  };
  const up = fmDir ? [el('li', { class: 'fm-row' }, el('button', { class: 'cfg-file fm-entry is-dir fm-up', type: 'button', onclick: () => openFolder(fmParent(fmDir)) }, icon('chev'), el('span', { class: 'fm-name' }, '..'), el('span', { class: 'fm-meta' }, 'up')))] : [];
  $('cfg-list').replaceChildren(...up, ...(shown.length ? shown.map(row) : [el('li', { class: 'cfg-empty' }, q ? 'Nothing here matches.' : 'This folder is empty.')]));
  renderCfgStart();
}

// Before a file is open: what can be done here, and on Bukkit-family
// servers each plugin's main config one click away.
function renderCfgStart() {
  let box = $('cfg-start');
  if (!box) {
    box = el('div', { class: 'cfg-start', id: 'cfg-start' });
    $('cfg-code').before(box);
  }
  box.hidden = Boolean(cfgOpen);
  if (cfgOpen) return;
  if (fmSelected) {
    const f = fmSelected;
    box.replaceChildren(
      el('dl', { class: 'fm-facts' },
        el('dt', {}, 'Size'), el('dd', {}, f.size == null ? '–' : fmt.bytes(f.size)),
        el('dt', {}, 'Changed'), el('dd', {}, f.modified ? fmt.relative(f.modified) : '–')),
      el('p', { class: 'note' }, f.reason === 'large' ? 'Too large to edit here (1 MB max). Download it, or edit it on the server.' : f.reason === 'binary' ? 'Not a text file, so it can\'t be edited here.' : ''),
      el('div', { class: 'cfg-quick' },
        el('a', { class: 'btn btn-sm', href: `/api/files/download?path=${encodeURIComponent(f.path)}`, download: '' }, icon('download'), 'Download'),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => fmRename(f.path) }, icon('copy'), 'Rename or move'),
        el('button', { class: 'btn btn-sm', type: 'button', onclick: () => fmDelete(f.path, 'file') }, icon('delete'), 'Delete')));
    return;
  }
  const main = fmDir === '' || fmDir === 'plugins' || fmDir === 'config'
    ? fmEntries.filter((e) => e.type === 'file' && e.editable && /^(server\.properties|config\.ya?ml|bukkit\.yml|spigot\.yml)$/.test(e.name)).slice(0, 8)
    : [];
  box.replaceChildren(
    el('p', { class: 'note' }, 'Click a text file to edit it; saving shows the changes first and keeps the previous version for Revert. Deleting archives the file or folder under Backups first.'),
    ...(main.length ? [el('div', { class: 'cfg-quick' }, ...main.map((e) => el('button', { class: 'btn btn-sm', type: 'button', onclick: () => openConfig(fmJoin(fmDir, e.name), e) }, icon('settings'), e.name)))] : []));
}

async function openFolder(dir) {
  if (cfgDirty() && !(await confirmAction({ title: 'Discard your changes?', body: `${cfgOpen.path} has unsaved changes.`, confirm: 'Discard', tone: 'danger', icon: 'delete' }))) return;
  try {
    const r = await api('GET', `/api/files?path=${encodeURIComponent(dir)}`);
    fmDir = r.path;
    fmEntries = r.entries;
    if (cfgOpen && fmParent(cfgOpen.path) !== fmDir) closeEditor();
    if (fmSelected && fmParent(fmSelected.path) !== fmDir) fmSelected = null;
    $('cfg-filter').value = '';
    renderCrumbs();
    renderCfgList();
    if (r.truncated) toast(`This folder has more than ${r.entries.length} entries; only the first are listed.`, 'bad');
    try {
      sessionStorage.setItem('rconsole.files.dir', fmDir);
    } catch {}
  } catch (e) {
    if (dir) return openFolder(fmParent(dir));
    $('cfg-list').replaceChildren(el('li', { class: 'cfg-empty' }, e.message));
  }
}

async function loadConfigs() {
  if (!atLeast('admin')) return;
  let dir = fmDir;
  try {
    dir = fmDir || sessionStorage.getItem('rconsole.files.dir') || '';
  } catch {}
  await openFolder(dir);
}

function closeEditor() {
  cfgOpen = null;
  $('cfg-code').hidden = true;
  $('cfg-revert').hidden = true;
  $('cfg-save').disabled = true;
  $('cfg-save').hidden = true;
  $('fm-file-actions').hidden = true;
  $('cfg-name').textContent = 'Choose a file';
  $('cfg-info').textContent = 'Everything in the server folder. Text files open here.';
}

const cfgDirty = () => cfgOpen && $('cfg-text').value !== cfgOpen.original;

function cfgCheck() {
  const text = $('cfg-text').value;
  let problem = null;
  if (/\.json$/i.test(cfgOpen.path)) {
    try {
      if (text.trim()) JSON.parse(text);
    } catch (err) {
      problem = `Invalid JSON: ${err.message}`;
    }
  } else if (/\.ya?ml$/i.test(cfgOpen.path)) {
    const i = text.split('\n').findIndex((l) => /^ *\t/.test(l));
    if (i >= 0) problem = `YAML can't be indented with tabs (line ${i + 1})`;
  }
  $('cfg-error').textContent = problem || '';
  $('cfg-error').hidden = !problem;
  $('cfg-save').disabled = !cfgDirty() || Boolean(problem) || Boolean(cfgOpen.protected);
  return problem;
}

function cfgNumbers() {
  const n = $('cfg-text').value.split('\n').length;
  if ($('cfg-lines').dataset.n !== String(n)) {
    $('cfg-lines').textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
    $('cfg-lines').dataset.n = n;
  }
  $('cfg-lines').scrollTop = $('cfg-text').scrollTop;
}

function showFile(f) {
  cfgOpen = { path: f.path, original: f.content, hasPrevious: f.hasPrevious, sha256: f.sha256, protected: f.protected };
  fmSelected = null;
  $('cfg-name').textContent = f.path.split('/').pop();
  $('cfg-info').textContent = `${f.path} · changed ${fmt.relative(f.modified)}${f.protected ? ` · read only: ${f.protected}` : ''}`;
  $('cfg-text').value = f.content;
  $('cfg-text').readOnly = Boolean(f.protected);
  $('cfg-code').hidden = false;
  $('cfg-revert').hidden = !f.hasPrevious;
  $('cfg-save').hidden = Boolean(f.protected);
  $('fm-file-actions').hidden = false;
  cfgNumbers();
  cfgCheck();
  renderCfgList();
}

async function openConfig(path, entry = null) {
  if (cfgOpen?.path === path) return;
  if (cfgDirty() && !(await confirmAction({ title: 'Discard your changes?', body: `${cfgOpen.path} has unsaved changes.`, confirm: 'Discard', tone: 'danger', icon: 'delete' }))) return;
  try {
    const f = await api('GET', `/api/files/file?path=${encodeURIComponent(path)}`);
    if (f.content == null) {
      closeEditor();
      fmSelected = { path: f.path, size: f.size, modified: f.modified, reason: f.reason };
      $('cfg-name').textContent = f.path.split('/').pop();
      $('cfg-info').textContent = f.path;
      renderCfgList();
      return;
    }
    showFile(f);
  } catch (e) {
    toast(e.message, 'bad');
    if (entry) fmSelected = null;
  }
}

async function saveConfig() {
  if (!cfgOpen || cfgCheck() || !cfgDirty()) return;
  const text = $('cfg-text').value;
  // Within each change, removed lines before added ones, as diffs read.
  const diff = diffLines(cfgOpen.original, text).reduce((out, x) => {
    if (x[0] === '-') {
      let i = out.length;
      while (i > 0 && out[i - 1][0] === '+') i--;
      out.splice(i, 0, x);
    } else out.push(x);
    return out;
  }, []);
  const view = el('pre', { class: 'cfg-diff' }, ...diff.map(([t, l]) => el('span', { class: { '+': 'd-add', '-': 'd-del', '…': 'gap', ' ': '' }[t] }, t === '…' ? '⋯\n' : `${t} ${l}\n`)));
  const props = cfgOpen.path === 'server.properties' ? ' rconsole keeps its own RCON settings in this file whatever you change there.' : '';
  if (!(await confirmAction({ title: `Save ${cfgOpen.path.split('/').pop()}?`, body: `The previous version is kept for Revert. Most plugins and mods read their files at startup: reload or restart afterwards.${props}`, confirm: 'Save', icon: 'save', content: view }))) return;
  await busy($('cfg-save'), async () => {
    try {
      const f = await api('PUT', '/api/files/file', { path: cfgOpen.path, content: text, expected: cfgOpen.sha256 });
      showFile(f);
      $('cfg-info').textContent = `${f.path} · saved just now`;
      toast(`Saved ${f.path}. Reload or restart to apply.`);
      refreshStatus(true);
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
}

// Actions for one entry: a small menu next to it.
function fmMenu(anchor, p, e) {
  document.querySelector('.fm-menu')?.remove();
  const item = (label, iconName, fn, danger) => el('button', { type: 'button', role: 'menuitem', class: danger ? 'danger' : '', onclick: () => {
    menu.remove();
    fn();
  } }, icon(iconName), label);
  const menu = el('div', { class: 'fm-menu', role: 'menu' },
    el('a', { role: 'menuitem', href: `/api/files/download?path=${encodeURIComponent(p)}`, download: '', onclick: () => menu.remove() }, icon('download'), e.type === 'dir' ? 'Download as .tar.gz' : 'Download'),
    item('Rename or move', 'copy', () => fmRename(p)),
    item('Delete', 'delete', () => fmDelete(p, e.type), true));
  anchor.closest('.fm-row').append(menu);
  menu.querySelector('a,button').focus();
  const close = (ev) => {
    if (!menu.contains(ev.target) && ev.target !== anchor) {
      menu.remove();
      document.removeEventListener('pointerdown', close);
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', close));
  menu.addEventListener('keydown', (ev) => ev.key === 'Escape' && (menu.remove(), anchor.focus()));
}

// A text field in the confirm dialog; resolves with its value or null.
async function askText({ title, body, label, value = '', confirm, iconName = 'add' }) {
  const input = el('input', { class: 'field', value, 'aria-label': label, spellcheck: 'false', autocomplete: 'off' });
  const field = el('label', { class: 'fld' }, el('span', {}, label), input);
  setTimeout(() => {
    input.focus();
    const dot = value.lastIndexOf('.');
    input.setSelectionRange(value.lastIndexOf('/') + 1, dot > value.lastIndexOf('/') + 1 ? dot : value.length);
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), $('dialog-confirm').click()));
  if (!(await confirmAction({ title, body, confirm, icon: iconName, content: field }))) return null;
  return input.value.trim().replace(/^\/+|\/+$/g, '') || null;
}

async function fmRename(p) {
  const to = await askText({ title: `Rename ${p.split('/').pop()}`, body: 'A new name, or a path from the server folder to move it (for example plugins/old/config.yml).', label: 'New name or path', value: p, confirm: 'Rename', iconName: 'copy' });
  if (!to || to === p) return;
  try {
    await api('POST', '/api/files/move', { from: p, to: to.includes('/') ? to : fmJoin(fmParent(p), to) });
    if (cfgOpen?.path === p) closeEditor();
    if (fmSelected?.path === p) fmSelected = null;
    toast(`Moved ${p} to ${to}.`);
    openFolder(fmDir);
  } catch (e) {
    toast(e.message, 'bad');
  }
}

async function fmDelete(p, type) {
  if (!(await confirmAction({ title: `Delete ${p.split('/').pop()}?`, body: `${type === 'dir' ? 'The folder and everything in it are' : 'The file is'} archived under Backups (deleted-files) first, then removed from the server folder.`, confirm: 'Delete', tone: 'danger', icon: 'delete' }))) return;
  try {
    const r = await api('POST', '/api/files/delete', { path: p });
    if (cfgOpen?.path === p) closeEditor();
    if (fmSelected?.path === p) fmSelected = null;
    toast(`Deleted ${p}. A copy is in ${r.archived}.`);
    openFolder(fmDir);
  } catch (e) {
    toast(e.message, 'bad');
  }
}

async function fmNew(kind) {
  const name = await askText({ title: kind === 'dir' ? 'New folder' : 'New file', body: `In ${fmDir || 'the server folder'}.`, label: 'Name', value: kind === 'dir' ? '' : 'new.yml', confirm: 'Create' });
  if (!name) return;
  const p = fmJoin(fmDir, name);
  try {
    if (kind === 'dir') await api('POST', '/api/files/folder', { path: p });
    else await api('PUT', '/api/files/file', { path: p, content: '', expected: null });
    await openFolder(fmDir);
    if (kind === 'file') openConfig(p);
  } catch (e) {
    toast(e.message, 'bad');
  }
}

// Uploads: each file is sent in resumable chunks (as world uploads), then
// placed in the open folder. Archives can be unpacked into a folder.
const ARCHIVE_RE = /\.(zip|tar|tar\.gz|tgz|tar\.zst|tar\.xz)$/i;
let fmUploading = null;
async function fmUpload(list) {
  if (fmUploading) return toast('An upload is running; wait for it to finish.', 'bad');
  const all = [...list];
  if (!all.length) return;
  let unpack = false;
  if (all.length === 1 && ARCHIVE_RE.test(all[0].name)) {
    const box = el('label', { class: 'check' }, el('input', { type: 'checkbox' }), ` Unpack into a folder named ${all[0].name.replace(ARCHIVE_RE, '')}`);
    if (!(await confirmAction({ title: `Upload ${all[0].name}?`, body: `Into ${fmDir || 'the server folder'}.`, confirm: 'Upload', icon: 'upload', content: box }))) return;
    unpack = box.querySelector('input').checked;
  }
  const dir = fmDir;
  fmUploading = { cancelled: false, xhr: null };
  const btn = $('fm-upload');
  btn.setAttribute('aria-busy', 'true');
  try {
    for (const [i, file] of all.entries()) {
      const name = unpack ? file.name.replace(ARCHIVE_RE, '') : file.name;
      const label = all.length > 1 ? `${i + 1}/${all.length} ` : '';
      const id = await chunkedUpload('/api/files/uploads', file, fmUploading, (sent) => ($('cfg-info').textContent = `Uploading ${label}${file.name}: ${Math.floor((sent / file.size) * 100)}%`), (msg) => ($('cfg-info').textContent = msg));
      await api('POST', '/api/files/place', { upload: id, dir, name, unpack });
    }
    toast(all.length > 1 ? `Uploaded ${all.length} files.` : `Uploaded ${all[0].name}${unpack ? ' and unpacked it' : ''}.`);
  } catch (e) {
    toast(e.message, 'bad');
  } finally {
    btn.removeAttribute('aria-busy');
    fmUploading = null;
    if (!cfgOpen) $('cfg-info').textContent = 'Everything in the server folder. Text files open here.';
    if (dir === fmDir) openFolder(fmDir);
  }
}

$('cfg-text').addEventListener('input', () => {
  cfgNumbers();
  cfgCheck();
});
$('cfg-text').addEventListener('scroll', () => ($('cfg-lines').scrollTop = $('cfg-text').scrollTop));
$('cfg-text').addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.currentTarget.readOnly) {
    e.preventDefault();
    const t = e.currentTarget;
    t.setRangeText('  ', t.selectionStart, t.selectionEnd, 'end');
    cfgNumbers();
    cfgCheck();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveConfig();
  }
});
$('cfg-save').addEventListener('click', saveConfig);
$('cfg-filter').addEventListener('input', renderCfgList);
$('fm-upload').addEventListener('click', () => $('fm-file').click());
$('fm-file').addEventListener('change', (e) => {
  fmUpload(e.target.files);
  e.target.value = '';
});
$('fm-new-folder').addEventListener('click', () => fmNew('dir'));
$('fm-new-file').addEventListener('click', () => fmNew('file'));
$('fm-download').addEventListener('click', () => cfgOpen && location.assign(`/api/files/download?path=${encodeURIComponent(cfgOpen.path)}`));
$('fm-rename').addEventListener('click', () => cfgOpen && fmRename(cfgOpen.path));
$('fm-delete').addEventListener('click', () => cfgOpen && fmDelete(cfgOpen.path, 'file'));
// Files dropped on the browser go into the open folder.
$('cfg-list').closest('.cfg-panel').addEventListener('dragover', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  e.currentTarget.classList.add('fm-drop');
});
$('cfg-list').closest('.cfg-panel').addEventListener('dragleave', (e) => !e.currentTarget.contains(e.relatedTarget) && e.currentTarget.classList.remove('fm-drop'));
$('cfg-list').closest('.cfg-panel').addEventListener('drop', (e) => {
  e.currentTarget.classList.remove('fm-drop');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  fmUpload(e.dataTransfer.files);
});
$('cfg-revert').addEventListener('click', async (e) => {
  if (!cfgOpen || !(await confirmAction({ title: 'Revert to the previous version?', body: `${cfgOpen.path} goes back to how it was before the last save from rconsole.`, confirm: 'Revert', icon: 'rollback' }))) return;
  await busy(e.currentTarget, async () => {
    try {
      const f = await api('POST', '/api/files/revert', { path: cfgOpen.path });
      showFile(f);
      toast(`Reverted ${f.path}.`);
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
});
window.addEventListener('beforeunload', (e) => {
  if (cfgDirty() || fmUploading) e.preventDefault();
});
viewLoaders['server/files'] = loadConfigs;

// ---------------------------------------------------------------------------
// Player profile
// ---------------------------------------------------------------------------

let psPlayer = null;
let psTab = 'inventory';
const itemLabel = (id) => id.replace(/_/g, ' ');

// A colour hint per material, since rconsole ships no item textures.
const MATERIALS = [
  ['netherite', /netherite|ancient_debris/], ['diamond', /diamond/], ['gold', /gold|golden/], ['iron', /iron|chainmail|anvil|bucket|shears|minecart/],
  ['copper', /copper/], ['emerald', /emerald/], ['redstone', /redstone|tnt|red_/], ['lapis', /lapis|blue_/], ['amethyst', /amethyst|ender|purpur|chorus|shulker|enchant|experience/],
  ['wood', /oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped|_log|planks|stick|bow|arrow|crossbow|chest|barrel|crafting|book|saddle|leather|name_tag|lead/],
  ['food', /beef|pork|chicken|mutton|rabbit|cod|salmon|bread|apple|carrot|potato|kelp|melon|pie|stew|soup|cookie|cake|berries|beetroot|honey/],
  ['plant', /sapling|leaves|grass|vine|sugar_cane|seeds|wheat|moss|flower|fern|cactus|lily|sea_pickle|slime/],
  ['stone', /stone|cobble|deepslate|granite|diorite|andesite|tuff|basalt|blackstone|dripstone|gravel|flint|furnace|bone|cobweb/],
];
const materialOf = (id) => MATERIALS.find(([, re]) => re.test(id))?.[0] || 'misc';
const abbr = (id) => id.split('_').filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

function slot(it, { selected = false, label = '' } = {}) {
  if (!it) return el('span', { class: `slot empty${selected ? ' selected' : ''}`, title: label ? `${label[0].toUpperCase()}${label.slice(1)}: empty` : 'Empty' }, label ? el('span', { class: 'slot-label' }, label) : null);
  const name = it.name || itemLabel(it.id);
  return el('span', { class: `slot m-${materialOf(it.id)}${it.enchanted ? ' ench' : ''}${selected ? ' selected' : ''}`, title: `${name}${it.name ? ` (${itemLabel(it.id)})` : ''}${it.count > 1 ? ` × ${it.count}` : ''}${it.enchanted ? ' · enchanted' : ''}` },
    el('span', { class: 'slot-swatch', 'aria-hidden': 'true' }),
    el('span', { class: 'slot-name' }, it.name || itemLabel(it.id)),
    el('span', { class: 'slot-abbr', 'aria-hidden': 'true' }, abbr(it.id)),
    it.count > 1 ? el('span', { class: 'slot-count' }, String(it.count)) : null);
}

function meter(value, max, cls) {
  const fill = el('span', { class: 'meter-fill' });
  fill.style.width = `${Math.max(0, Math.min(100, (value / max) * 100))}%`; // CSSOM: allowed by the CSP, unlike style attributes
  return el('span', { class: `meter ${cls}` }, fill);
}

// Equipment, the 3×9 inventory and the hotbar, laid out as in the game.
// `savedAt` marks a copy from the player file.
function inventoryPanel(inv, savedAt) {
  return el('div', { class: 'ps-inv' },
    el('div', { class: 'ps-inv-group' },
      el('h4', {}, 'Equipment'),
      el('div', { class: 'slots gear' },
        ...['head', 'chest', 'legs', 'feet'].map((k) => slot(inv.gear[k], { label: k })),
        el('span', { class: 'slot-gap', 'aria-hidden': 'true' }),
        slot(inv.gear.offhand, { label: 'offhand' }))),
    el('div', { class: 'ps-inv-group' },
      el('h4', {}, 'Inventory'),
      el('div', { class: 'slots' }, ...inv.inventory.map((it) => slot(it)))),
    el('div', { class: 'ps-inv-group' },
      el('h4', {}, 'Hotbar'),
      el('div', { class: 'slots hotbar' }, ...inv.hotbar.map((it, i) => slot(it, { selected: i === inv.selected })))),
    savedAt ? el('p', { class: 'note ps-foot' }, `As last saved by the server, ${fmt.relative(savedAt)}.`) : null);
}

// Time machine: the player at each backup, what's missing now, and putting
// the inventory or ender chest back (lib/timemachine.js).
const tmLabel = (b) => `${fmt.date(b.created)} · ${fmt.bytes(b.size)}`;
const itemLine = (x) => el('li', { class: `tm-item m-${materialOf(x.id)}${x.enchanted ? ' ench' : ''}` },
  el('span', { class: 'slot-swatch', 'aria-hidden': 'true' }), el('b', {}, `${x.count.toLocaleString()}×`), ' ', x.name || itemLabel(x.id), x.name ? el('span', { class: 'note' }, ` ${itemLabel(x.id)}`) : null, x.enchanted && !x.name ? el('span', { class: 'note' }, ' enchanted') : null);

function enderPanel(list) {
  return el('div', { class: 'ps-inv' }, el('div', { class: 'ps-inv-group' }, el('h4', {}, 'Ender chest'), el('div', { class: 'slots' }, ...list.map((it) => slot(it)))));
}

function timeMachinePanel(p) {
  const root = el('div', { class: 'tm' });
  const pick = el('select', { class: 'field', 'aria-label': 'Backup' });
  const body = el('div', { class: 'tm-body' });
  let list = null;
  let shown = null;
  let poll = null;
  const q = `?uuid=${encodeURIComponent(p.uuid)}`;
  const base = `/api/players/${encodeURIComponent(p.name)}/timemachine`;

  async function look() {
    clearTimeout(poll);
    const name = pick.value;
    if (!name) return;
    const b = list.backups.find((x) => x.name === name);
    body.replaceChildren(el('p', { class: 'note tm-wait' }, el('span', { class: 'spinner' }), b && !b.indexed ? ` Reading ${fmt.date(b.created)}'s backup. The first look takes a while for a big world; after that it's instant.` : ' Loading…'));
    try {
      const r = await api('GET', `${base}/${encodeURIComponent(name)}${q}`);
      if (pick.value !== name || !root.isConnected) return;
      if (r.indexing) {
        poll = setTimeout(look, 2000);
        return;
      }
      if (b) b.indexed = true;
      shown = r;
      render();
    } catch (e) {
      body.replaceChildren(el('p', { class: 'note' }, `Can't read that backup: ${e.message}`));
    }
  }

  function render() {
    const r = shown;
    const b = list.backups.find((x) => x.name === r.backup);
    if (!r.found) return body.replaceChildren(el('p', { class: 'note' }, `${p.name} has no saved data in this backup (they hadn't joined yet).`));
    const miss = [...(r.inventory?.missing || []).map((x) => ({ ...x, where: 'inv' })), ...(r.enderChest?.missing || []).map((x) => ({ ...x, where: 'ender' }))];
    const gained = r.inventory?.gained || [];
    const [inv, end] = [el('input', { type: 'checkbox', checked: true }), el('input', { type: 'checkbox', checked: Boolean(r.enderChest?.missing.length) })];
    const restoreBtn = el('button', { class: 'btn btn-primary btn-sm', type: 'button' }, icon('rollback'), 'Restore');
    restoreBtn.addEventListener('click', () => restore({ backup: r.backup, when: fmt.date(b.created) }, [inv.checked && 'inventory', end.checked && 'ender'].filter(Boolean), restoreBtn));
    let tab = 'inventory';
    const view = el('div', {});
    const tabs = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Show' },
      ...[['inventory', 'Inventory'], ['ender', 'Ender chest']].map(([k, label]) => el('button', { role: 'radio', type: 'button', 'aria-checked': String(k === tab), onclick: (e) => {
        tab = k;
        for (const x of e.currentTarget.parentNode.children) x.setAttribute('aria-checked', String(x === e.currentTarget));
        view.replaceChildren(k === 'ender' ? enderPanel(r.then.ender) : inventoryPanel(r.then, null));
      } }, label)));
    view.replaceChildren(inventoryPanel(r.then, null));
    body.replaceChildren(
      el('section', { class: `tm-diff ${miss.length ? 'has-missing' : ''}` },
        el('h4', {}, miss.length ? `Missing since ${fmt.date(b.created)}` : 'Nothing missing'),
        miss.length
          ? el('ul', { class: 'tm-items' }, ...miss.slice(0, 24).map((x) => itemLine(x)), miss.length > 24 ? el('li', { class: 'note' }, `and ${miss.length - 24} more`) : null)
          : el('p', { class: 'note' }, `${p.name} has everything they had then${r.now?.from === 'saved' ? ' (compared with their last saved state)' : ''}.`),
        gained.length ? el('p', { class: 'note' }, `Picked up since: ${gained.slice(0, 6).map((x) => `${x.count}× ${x.name || itemLabel(x.id)}`).join(', ')}${gained.length > 6 ? ', …' : ''}.`) : null,
        r.now?.online && r.now.from === 'saved' ? el('p', { class: 'note' }, 'Their live inventory couldn\'t be read, so this compares with their last saved state.') : null),
      el('div', { class: 'tm-restore', 'data-min-role': 'admin' },
        el('label', { class: 'check' }, inv, 'Inventory and armor'),
        el('label', { class: 'check' }, end, 'Ender chest'),
        restoreBtn,
        el('p', { class: 'note' }, 'Position, health and levels stay as they are now. rconsole keeps what they have now, so you can go back.')),
      el('div', { class: 'tm-then' }, el('div', { class: 'tm-then-head' }, el('h4', {}, `Then: ${[r.then.dimension, r.then.pos?.join(' '), r.then.xp != null ? `level ${r.then.xp}` : null].filter(Boolean).join(' · ')}`), tabs), view));
  }

  async function restore(src, parts, button) {
    if (!parts.length) return toast('Tick the inventory, the ender chest or both.', 'bad');
    const what = parts.length === 2 ? 'inventory and ender chest' : parts[0] === 'ender' ? 'ender chest' : 'inventory';
    const online = psView?.online;
    const ok = await confirmAction({
      title: src.undo ? `Undo the restore for ${p.name}?` : `Restore ${p.name}'s ${what}?`,
      body: `${src.undo ? `Puts back the ${what} they had before the restore at ${src.when}.` : `Replaces what they carry now with the ${what} from ${src.when}.`}${online ? `\n${p.name} is online: they are kicked first and can rejoin right after.` : ''}`,
      confirm: online ? 'Kick and restore' : 'Restore', tone: 'primary', icon: 'rollback',
    });
    if (!ok) return;
    await busy(button, async () => {
      try {
        const r = await api('POST', `${base}/restore`, { uuid: p.uuid, parts, kick: Boolean(online), ...(src.undo ? { undo: src.undo } : { backup: src.backup }) });
        toast(`${p.name}'s ${what} is back${r.kicked ? '; they can join again' : ''}.`);
        await load();
      } catch (e) {
        toast(e.message, 'bad');
      }
    });
  }

  async function load() {
    try {
      list = await api('GET', `${base}${q}`);
    } catch (e) {
      return root.replaceChildren(el('p', { class: 'note' }, e.message));
    }
    if (!list.backups.length) return root.replaceChildren(el('p', { class: 'note ps-empty' }, `No backups of ${list.world} yet. Each backup becomes a point in time you can bring ${p.name}'s things back from.`));
    const keep = pick.value;
    pick.replaceChildren(...list.backups.map((b) => el('option', { value: b.name, selected: b.name === keep || undefined }, tmLabel(b))));
    const undo = list.undo.length && atLeast('admin')
      ? el('div', { class: 'tm-undo' }, el('span', { class: 'note' }, `Restored ${fmt.relative(list.undo[0].at)}.`), (() => {
          const btn = el('button', { class: 'btn btn-quiet btn-sm', type: 'button' }, icon('rollback'), 'Undo');
          btn.addEventListener('click', () => restore({ undo: list.undo[0].stamp, when: fmt.date(list.undo[0].at) }, ['inventory', 'ender'], btn));
          return btn;
        })())
      : null;
    root.replaceChildren(el('div', { class: 'tm-head' }, el('label', { class: 'fld' }, el('span', {}, 'Back to'), pick), undo), body);
    look();
  }
  pick.addEventListener('change', look);
  load();
  return root;
}

function statsPanel(st, adv) {
  const tile = (label, value, sub) => el('div', { class: 'ps-tile' }, el('dt', {}, label), el('dd', {}, value, sub ? el('small', {}, sub) : null));
  const list = (title, items) => {
    if (!items.length) return null;
    const max = items[0].count || 1;
    return el('div', { class: 'ps-top' }, el('h4', {}, title), el('ol', {}, ...items.map((x) => {
      const bar = el('span', { class: 'ps-bar' });
      bar.style.width = `${Math.max(4, (x.count / max) * 100)}%`;
      return el('li', {}, el('span', { class: 'ps-top-name' }, itemLabel(x.id)), el('b', {}, x.count.toLocaleString()), bar);
    })));
  };
  return el('div', { class: 'ps-stats' },
    el('dl', { class: 'ps-strip ps-strip-4' },
      tile('Play time', st.playTimeTicks != null ? fmt.duration(Math.round(st.playTimeTicks / 20)) : '–'),
      tile('Deaths', st.deaths.toLocaleString()),
      tile('Mob kills', st.mobKills.toLocaleString(), st.playerKills ? `· ${st.playerKills.toLocaleString()} player${st.playerKills === 1 ? '' : 's'}` : null),
      tile('Advancements', adv ? String(adv.done) : '–'),
      tile('Walked', `${st.walkedKm.toLocaleString()} km`),
      tile('Blocks mined', st.blocksMined.toLocaleString()),
      tile('Jumps', st.jumps.toLocaleString()),
      tile('Flown', `${(st.flownKm || 0).toLocaleString()} km`)),
    el('div', { class: 'ps-tops' }, list('Most mined', st.topMined), list('Most used', st.topUsed), list('Most killed', st.topKilled)));
}

// What the open profile shows, so live updates can change parts in place
// (the teleport field, the chosen tab and an unsaved game mode stay as they are).
let psView = null;

function headerPills(p) {
  const L = p.live;
  const pills = [];
  if (L) {
    pills.push(el('span', { class: 'pill ok live', title: 'Updates live while this is open' }, el('span', { class: 'dot', 'aria-hidden': 'true' }), 'Online'));
    if (L.gamemode) pills.push(el('span', { class: 'pill' }, L.gamemode[0].toUpperCase() + L.gamemode.slice(1)));
    if (L.dimension) pills.push(el('span', { class: `pill dim-${L.dimension.replace(/[^a-z_]/g, '')}` }, itemLabel(L.dimension.replace(/^the_/, 'the ')).replace(/^\w/, (c) => c.toUpperCase())));
  } else {
    pills.push(el('span', { class: 'pill' }, 'Offline'));
    if (p.saved?.savedAt) pills.push(el('span', { class: 'note' }, `Saved ${fmt.relative(p.saved.savedAt)}`));
  }
  $('ps-sub').replaceChildren(...pills);
}

function vitalsStrip(L) {
  const hpLow = (L.health ?? 20) <= 6;
  const coords = L.pos.map((v) => Math.round(v)).join(' ');
  const copy = el('button', { class: 'ps-copy mono', type: 'button', title: 'Copy coordinates', onclick: () => copyText(coords, 'Coordinates') }, coords, icon('copy'));
  return el('dl', { class: 'ps-strip ps-vitals' },
    el('div', { class: 'ps-tile' }, el('dt', {}, 'Position'), el('dd', {}, copy)),
    el('div', { class: 'ps-tile' }, el('dt', {}, 'Health'), el('dd', { class: hpLow ? 'low' : '' }, `${L.health ?? '–'}`, el('small', {}, '/ 20'), meter(L.health || 0, 20, hpLow ? 'hp low' : 'hp'))),
    el('div', { class: 'ps-tile' }, el('dt', {}, 'Food'), el('dd', {}, `${L.food ?? '–'}`, el('small', {}, '/ 20'), meter(L.food || 0, 20, 'food'))),
    el('div', { class: 'ps-tile' }, el('dt', {}, 'Level'), el('dd', {}, String(L.xp ?? '–'))));
}

function showPanel() {
  const v = psView;
  if (!v?.panelBody) return;
  const d = v.data;
  if (psTab === 'timemachine') v.tm ||= timeMachinePanel(d.player);
  v.panelBody.replaceChildren(psTab === 'stats' ? statsPanel(d.stats, d.advancements) : psTab === 'timemachine' ? v.tm : inventoryPanel(d.inv, d.savedAt));
  for (const b of v.tabs?.children || []) b.setAttribute('aria-checked', String(b.dataset.tab === psTab));
}

function renderPlayer(p) {
  const L = p.live;
  headerPills(p);
  psView = { online: Boolean(L), data: {} };
  const parts = [];
  if (L) {
    psView.vitals = vitalsStrip(L);
    parts.push(psView.vitals);

    const refresh = () => setTimeout(() => openPlayer(p.name, p.uuid), 400);
    const act = (label, cmd, opts) => rowActionBtn(label, opts?.icon || 'players', cmd, opts?.confirm, opts?.danger, refresh);
    const tpField = el('input', { class: 'field', placeholder: 'Player or x y z', 'aria-label': 'Teleport to a player or coordinates', maxlength: 60, autocomplete: 'off' });
    const modes = el('select', { class: 'field', 'aria-label': 'Game mode' }, ...['survival', 'creative', 'adventure', 'spectator'].map((m) => el('option', { value: m, selected: m === L.gamemode || undefined }, m[0].toUpperCase() + m.slice(1))));
    const modeBtn = el('button', { class: 'btn btn-sm', type: 'button', disabled: true, onclick: (e) => busy(e.currentTarget, () => mutate(`gamemode ${modes.value} ${p.name}`)).then(refresh) }, 'Apply');
    modes.addEventListener('change', () => { modeBtn.disabled = modes.value === psView.gamemode; });
    Object.assign(psView, { modes, modeBtn, gamemode: L.gamemode });
    parts.push(el('div', { class: 'ps-toolbar', 'data-min-role': 'moderator' },
      el('form', { class: 'join', onsubmit: (e) => {
        e.preventDefault();
        const t = tpField.value.trim();
        if (/^[A-Za-z0-9_]{1,16}$|^~?-?[\d.]+ ~?-?[\d.]+ ~?-?[\d.]+$/.test(t)) busy(e.submitter, () => mutate(`tp ${p.name} ${t}`)).then(refresh);
        else toast('Enter a player name or three coordinates.', 'bad');
      } }, tpField, el('button', { class: 'btn btn-sm' }, 'Teleport')),
      el('div', { class: 'join' }, modes, modeBtn),
      el('div', { class: 'ps-quick' },
        act('Heal', `effect give ${p.name} minecraft:instant_health 1 5`, { icon: 'add' }),
        act('Kick', `kick ${p.name}`, { icon: 'remove', confirm: { title: `Kick ${p.name}?`, confirm: 'Kick', tone: 'danger', icon: 'remove' } }),
        act('Clear inventory', `clear ${p.name}`, { icon: 'delete', danger: true, confirm: { title: `Clear ${p.name}'s inventory?`, body: 'Everything they carry is gone. This can\'t be undone.', confirm: 'Clear', tone: 'danger', icon: 'delete' } }))));
  }

  parts.push(accessBar(p));
  const inv = L || p.saved;
  Object.assign(psView.data, { inv, savedAt: L ? L.inventoryFrom : p.saved?.savedAt, stats: p.stats, advancements: p.advancements, player: p });
  const panels = [...(inv ? [['inventory', 'Inventory']] : []), ...(p.stats ? [['stats', 'Statistics']] : []), ...(p.uuid && atLeast('moderator') ? [['timemachine', 'Time machine']] : [])];
  if (panels.length) {
    if (!panels.some(([k]) => k === psTab)) psTab = panels[0][0];
    psView.panelBody = el('div', { class: 'ps-panel', role: 'tabpanel' });
    if (panels.length > 1) {
      psView.tabs = el('div', { class: 'segmented ps-tabs', role: 'radiogroup', 'aria-label': 'Show' },
        ...panels.map(([k, label]) => el('button', { role: 'radio', 'data-tab': k, onclick: () => { psTab = k; showPanel(); } }, label)));
      parts.push(psView.tabs);
    }
    parts.push(psView.panelBody);
    showPanel();
  } else parts.push(el('p', { class: 'note ps-empty' }, `${p.name} is offline and has no saved data in this world yet.`));
  $('ps-body').replaceChildren(...parts);
}

// Whitelist, operator and ban for anyone, online or not, and what the logs
// know about them: first and last visit, sessions, last address.
function accessBar(p) {
  const k = lc(p.name);
  const a = accessCache || { whitelist: [], ops: [], bans: [] };
  const wl = a.whitelist.some((x) => lc(x.name) === k);
  const op = a.ops.find((x) => lc(x.name) === k);
  const ban = a.bans.find((x) => lc(x.name) === k);
  const h = historyData?.players.find((x) => lc(x.name) === k);
  const refresh = () => setTimeout(() => openPlayer(p.name, p.uuid), 400);
  const act = (label, iconName, cmd, confirm, danger) => rowActionBtn(label, iconName, cmd, confirm, danger, refresh);
  const fact = (dt, dd) => (dd ? el('div', { class: 'ps-tile' }, el('dt', {}, dt), el('dd', {}, dd)) : null);
  return el('div', { class: 'ps-access' },
    h ? el('dl', { class: 'ps-strip ps-strip-4' },
      fact('First seen', fmt.relative(new Date(h.first).toISOString())),
      fact('Last seen', h.online ? 'Now' : fmt.relative(new Date(h.last).toISOString())),
      fact('Sessions', String(h.sessions)),
      fact('Playtime', dur(h.playtime))) : null,
    el('div', { class: 'ps-acts', 'data-min-role': 'moderator' },
      wl ? act('Remove from whitelist', 'remove', `whitelist remove ${p.name}`, null, true) : act('Whitelist', 'add', `whitelist add ${p.name}`),
      op ? act('Remove operator', 'op', `deop ${p.name}`, { title: `Remove operator rights from ${p.name}?`, confirm: 'Deop', tone: 'danger', icon: 'op' }, true) : act('Make operator', 'op', `op ${p.name}`, CONFIRM_ADD.op(p.name)),
      ban ? act('Unban', 'check', `pardon ${p.name}`) : act('Ban', 'ban', `ban ${p.name}`, CONFIRM_ADD.ban(p.name), true),
      el('button', { class: 'btn btn-quiet btn-sm', onclick: () => { $('player-sheet').close(); searchPlayerLogs(p.name); } }, icon('search'), 'Search logs'),
      h?.ip && atLeast('moderator') ? el('span', { class: 'note mono', title: 'Last address' }, h.ip) : null),
    ban ? el('p', { class: 'note' }, `Banned${banMeta(ban) ? `: ${banMeta(ban)}` : ''}.`) : null);
}

// A live update: vitals every few seconds, the whole profile now and then.
function updatePlayer(p, full) {
  const v = psView;
  if (!v || Boolean(p.live) !== v.online) { // came online or went offline: rebuild from a whole profile
    if (full) renderPlayer(p);
    else psTick = PS_FULL_EVERY - 1;
    return;
  }
  if (!p.live) return;
  const L = p.live;
  headerPills(p);
  const strip = vitalsStrip(L);
  v.vitals.replaceWith(strip);
  v.vitals = strip;
  if (L.gamemode && L.gamemode !== v.gamemode) {
    if (v.modeBtn.disabled) v.modes.value = L.gamemode; // leave a choice the user is about to apply
    v.gamemode = L.gamemode;
    v.modeBtn.disabled = v.modes.value === L.gamemode;
  }
  const d = v.data;
  if (full) Object.assign(d, { inv: L, savedAt: L.inventoryFrom, stats: p.stats || d.stats, advancements: p.advancements || d.advancements });
  else if (d.inv && L.selected !== d.inv.selected) d.inv = { ...d.inv, selected: L.selected };
  else return;
  showPanel();
}

const PS_LIVE_MS = 4000;
const PS_FULL_EVERY = 5; // the inventory every 20 s: on 26.x it takes a query per item
let psTimer = null;
let psTick = 0;

function psSchedule() {
  clearTimeout(psTimer);
  if ($('player-sheet').open && !document.hidden && psPlayer) psTimer = setTimeout(psLive, PS_LIVE_MS);
}

async function psLive() {
  const who = psPlayer;
  if (!who || !$('player-sheet').open || document.hidden) return;
  const full = ++psTick % PS_FULL_EVERY === 0 || !psView?.online;
  try {
    const p = await api('GET', `/api/players/${encodeURIComponent(who.name)}/profile${full ? (who.uuid ? `?uuid=${encodeURIComponent(who.uuid)}` : '') : '?part=vitals'}`);
    if (psPlayer === who && $('player-sheet').open) {
      updatePlayer(p, full);
    }
  } catch {} // a missed beat; the next one tries again
  if (psPlayer === who) psSchedule();
}

async function openPlayer(name, uuid) {
  const same = psPlayer?.name === name;
  psPlayer = { name, uuid };
  if (!same) psTab = 'inventory';
  psTick = 0;
  clearTimeout(psTimer);
  const sheet = $('player-sheet');
  $('ps-name').textContent = name;
  const img = el('img', { class: 'avatar', src: `https://mc-heads.net/avatar/${encodeURIComponent(uuid || name)}/64`, alt: '', width: 44, height: 44 });
  img.addEventListener('error', () => img.replaceWith(el('span', { class: 'ip-tile' }, icon('players'))));
  $('ps-avatar').replaceChildren(img);
  if (!sheet.open) {
    $('ps-sub').replaceChildren(el('span', { class: 'skeleton w40' }));
    $('ps-body').replaceChildren(el('div', { class: 'ps-strip ps-vitals ps-loading' }, ...[1, 2, 3, 4].map(() => el('div', { class: 'ps-tile' }, el('span', { class: 'skeleton w40' }), el('span', { class: 'skeleton w60' })))));
    sheet.showModal();
    $('ps-body').focus({ preventScroll: true }); // not the first header button: no focus ring on open
  }
  try {
    const [profile] = await Promise.all([
      api('GET', `/api/players/${encodeURIComponent(name)}/profile${uuid ? `?uuid=${encodeURIComponent(uuid)}` : ''}`),
      accessCache ? null : api('GET', '/api/access').then((a) => (accessCache = a)).catch(() => {}),
    ]);
    renderPlayer(profile);
  } catch (e) {
    $('ps-body').replaceChildren(el('p', { class: 'note ps-empty' }, `Can't load ${name}: ${e.message}`));
  }
  psSchedule();
}
$('player-sheet').addEventListener('close', () => {
  clearTimeout(psTimer);
  psPlayer = null;
  psView = null;
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(psTimer);
  else if (psPlayer && $('player-sheet').open) psLive(); // catch up right away
});
$('ps-close').addEventListener('click', () => $('player-sheet').close());
$('ps-refresh').addEventListener('click', (e) => psPlayer && busy(e.currentTarget, () => openPlayer(psPlayer.name, psPlayer.uuid)));
$('player-sheet').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// ---------------------------------------------------------------------------
// Players: chat (from the console's log stream)
// ---------------------------------------------------------------------------

const CHAT_MAX = 300;
let chatEvents = [];
const recentWeb = []; // own messages, to drop their echo from the log

// One log line → { time, kind, name, text } or null.
function parseChat(line) {
  const time = line.match(/^\[(?:\d{1,2}[A-Za-z]{3}\d{4} )?(\d{2}:\d{2}):\d{2}/)?.[1];
  const msg = line.match(/\]: (.*)$/)?.[1];
  if (!time || msg == null) return null;
  const body = msg.replace(/^System chat: /, '');
  let m;
  if ((m = body.match(/^\[Web(?: → you)?\] ([^:]{1,32}): (.*)$/))) return { time, kind: 'web', name: m[1], text: m[2] };
  if ((m = msg.match(/^(?:\[Not Secure\] )?<([^>]{1,48})> (.*)$/))) return { time, kind: 'chat', name: m[1].replace(/§./g, ''), text: m[2] };
  if ((m = body.match(/^\[Server\] (.*)$/))) return { time, kind: 'server', name: 'Server', text: m[1] };
  if ((m = body.match(/^\* ([A-Za-z0-9_]{1,16}) (.*)$/))) return { time, kind: 'emote', name: m[1], text: m[2] };
  if ((m = body.match(/^([A-Za-z0-9_]{1,16}) (joined|left) the game$/))) return { time, kind: m[2] === 'joined' ? 'join' : 'leave', name: m[1], text: '' };
  return null;
}

function chatRow(e) {
  if (e.kind === 'join' || e.kind === 'leave') {
    return el('li', { class: `chat-sys ${e.kind}` }, el('time', {}, e.time), el('span', {}, el('b', {}, e.name), e.kind === 'join' ? ' joined' : ' left'));
  }
  const player = e.kind === 'chat' || e.kind === 'emote';
  const nameBtn = player && /^[A-Za-z0-9_]{1,16}$/.test(e.name)
    ? el('button', { class: 'chat-name', type: 'button', title: `Whisper to ${e.name}`, onclick: () => whisperTo(e.name) }, e.name)
    : el('span', { class: 'chat-name' }, e.name);
  return el('li', { class: `chat-msg ${e.kind}` },
    player ? avatar(e.name) : el('span', { class: `chat-badge ${e.kind}` }, e.kind === 'web' ? 'Web' : 'S'),
    el('div', { class: 'chat-body' },
      el('div', { class: 'chat-meta' }, nameBtn, e.to ? el('span', { class: 'note' }, `→ ${e.to}`) : null, el('time', {}, e.time)),
      el('p', { class: e.kind === 'emote' ? 'emote' : '' }, e.text)),
    player && /^[A-Za-z0-9_]{1,16}$/.test(e.name)
      ? el('span', { class: 'chat-acts', 'data-min-role': 'moderator' },
          el('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => whisperTo(e.name) }, 'Whisper'),
          rowActionBtn('Kick', 'remove', `kick ${e.name}`, { title: `Kick ${e.name}?`, confirm: 'Kick', tone: 'danger', icon: 'remove' }, true))
      : null);
}

const chatMatches = (e) => {
  const q = $('filter').value.trim().toLowerCase();
  return !q || `${e.name} ${e.text}`.toLowerCase().includes(q);
};

function renderChat() {
  const list = $('chat-list');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const shown = chatEvents.filter(chatMatches);
  list.replaceChildren(...(shown.length
    ? shown.map(chatRow)
    : [el('li', { class: 'chat-empty' }, chatEvents.length ? 'Nothing in the chat matches the filter.' : 'No chat yet. Messages, joins and leaves appear here as they happen.')]));
  if (atBottom || !renderChat.done) list.scrollTop = list.scrollHeight;
  renderChat.done = true;
}

const chatVisible = () => document.body.dataset.area === 'console' && view === 'chat';

function resetChat(lines) {
  chatEvents = lines.map(parseChat).filter(Boolean).slice(-CHAT_MAX);
  if (chatVisible()) renderChat();
  if (document.body.dataset.area === 'dashboard') renderJoins();
}

function pushChat(line) {
  const e = parseChat(line);
  if (!e) return;
  if (e.kind === 'web') {
    const i = recentWeb.findIndex((w) => w.name === e.name && w.text === e.text && Date.now() - w.at < 15000);
    if (i >= 0) return void recentWeb.splice(i, 1); // already shown when sent
  }
  chatEvents.push(e);
  if (chatEvents.length > CHAT_MAX) chatEvents.shift();
  if (!chatVisible() || !chatMatches(e)) return;
  const list = $('chat-list');
  list.querySelector('.chat-empty')?.remove();
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.append(chatRow(e));
  while (list.childElementCount > CHAT_MAX) list.firstElementChild.remove();
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function fillChatTargets() {
  const sel = $('chat-form').elements.to;
  const current = sel.value;
  const online = lastStatus?.game?.players?.players || [];
  sel.replaceChildren(el('option', { value: '' }, 'Everyone'), ...online.map((n) => el('option', { value: n }, `Whisper to ${n}`)));
  if (current && online.includes(current)) sel.value = current;
}

function whisperTo(name) {
  if (!atLeast('moderator')) return;
  if (!chatVisible()) showTab('console/chat');
  fillChatTargets();
  const f = $('chat-form').elements;
  if (![...f.to.options].some((o) => o.value === name)) f.to.append(el('option', { value: name }, `Whisper to ${name}`));
  f.to.value = name;
  f.message.placeholder = `Whisper to ${name}…`;
  f.message.focus();
}

$('chat-form').elements.to.addEventListener('change', (e) => {
  $('chat-form').elements.message.placeholder = e.target.value ? `Whisper to ${e.target.value}…` : 'Message everyone…';
});
$('chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = $('chat-form').elements;
  const message = f.message.value.trim();
  if (!message) return;
  await busy($('chat-form').querySelector('.btn-primary'), async () => {
    try {
      const r = await api('POST', '/api/chat', { message, to: f.to.value || undefined });
      recentWeb.push({ name: r.user, text: r.text, at: Date.now() });
      const now = new Date();
      chatEvents.push({ time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`, kind: 'web', name: r.user, text: r.text, to: r.to });
      renderChat();
      f.message.value = '';
      f.message.focus();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
});



// ---------------------------------------------------------------------------
// Insights: problems
// ---------------------------------------------------------------------------

let problemDays = 1;

// The bell in the top bar: how many new errors and worse, red when critical.
function renderProblemsBadge(p) {
  const n = p?.unseen || 0;
  $('bell-count').hidden = !n;
  $('bell-count').textContent = n > 9 ? '9+' : String(n);
  $('bell').classList.toggle('critical', Boolean(p?.critical));
  $('bell').setAttribute('aria-label', n ? `Problems, ${n} new` : 'Problems');
  lastProblems = p;
}
let lastProblems = null;

function openProblems() {
  openDrawer('drawer-problems', $('pr-range').querySelector('[aria-checked=true]'));
  loadProblems();
}
$('bell').addEventListener('click', openProblems);

async function muteProblem(x, btn) {
  if (!(await confirmAction({ title: 'Mute this kind of problem?', body: `${problemTitle(x)}\nIt leaves this list, the bell and notifications until you unmute it.`, confirm: 'Mute', icon: 'mute' }))) return;
  await busy(btn, async () => {
    try {
      await api('POST', '/api/problems/mute', { key: x.key });
      toast('Muted.');
      loadProblems();
      refreshStatus(true);
    } catch (e) {
      toast(e.message, 'bad');
    }
  });
}

// "Error" says nothing; the log line itself is the better title.
const problemTitle = (x) => (x.kind === 'lag' && x.maxBehindMs ? `${x.title} (up to ${(x.maxBehindMs / 1000).toFixed(1)} s behind)`
  : x.kind === 'error' && x.message ? x.message.replace(/^\[[A-Za-z0-9_.-]{2,40}\] /, '').slice(0, 140) : x.title);

function searchLogsFor(text) {
  const f = $('ls-form').elements;
  $('ls-form').reset();
  f.q.value = text.replace(/\s+/g, ' ').slice(0, 120);
  showTab('insights/logs');
  searchLogsUi();
}

async function loadProblems() {
  skeletonRows($('pr-list'), 1);
  try {
    const o = await api('GET', `/api/problems?days=${problemDays}`);
    const g = o.groups;
    const unseen = g.filter((x) => x.unseen && x.severity !== 'warning').length;
    $('pr-info').textContent = g.length
      ? `${g.length} kind${g.length === 1 ? '' : 's'} of problem${g.length === 1 ? '' : 's'} in the last ${problemDays === 1 ? '24 hours' : '7 days'}${unseen ? `, ${unseen} new` : ''}.${o.timedOut ? ' Older logs were skipped (time limit).' : ''}`
      : 'Crashes, plugin failures and errors from the server log, and memory or RCON trouble on this machine.';
    $('pr-seen').disabled = !g.some((x) => x.unseen);
    $('pr-muted').hidden = !o.muted;
    $('pr-muted').replaceChildren(`${o.muted} muted kind${o.muted === 1 ? '' : 's'} hidden. `,
      atLeast('admin') ? el('button', { class: 'btn btn-quiet btn-sm', onclick: (e) => busy(e.currentTarget, () => api('POST', '/api/problems/mute', { all: true }).then(loadProblems)) }, 'Unmute all') : '');
    const titled = (x) => problemTitle(x) !== x.title;
    $('pr-list').replaceChildren(...(g.length ? g.map((x) => el('li', { class: `problem ${x.severity}${x.unseen ? ' unseen' : ''}` },
      el('span', { class: 'problem-icon' }, icon('alert')),
      el('div', { class: 'problem-main' },
        el('div', { class: 'problem-title' },
          el('b', {}, problemTitle(x)),
          x.plugin ? el('span', { class: 'pill' }, x.plugin) : null,
          x.unseen && x.severity !== 'warning' ? el('span', { class: 'pill new' }, 'New') : null),
        // Machine conditions are sentences, not log lines, and hold right now.
        x.message && !titled(x) ? el(x.kind === 'host' ? 'p' : 'code', { class: x.kind === 'host' ? 'problem-text' : 'problem-msg' }, x.message) : null,
        x.detail ? el('code', { class: 'problem-detail' }, x.detail) : null,
        x.hint ? el('p', { class: 'problem-hint' }, icon('check'), x.hint) : null,
        el('span', { class: 'problem-meta' }, x.kind === 'host' ? 'Now, on this machine' : `${x.count}× · last ${fmt.relative(new Date(x.last).toISOString())}${x.count > 1 ? ` · first ${fmt.relative(new Date(x.first).toISOString())}` : ''}`),
        el('div', { class: 'problem-acts' },
          (x.message && x.kind !== 'host') || x.kind === 'lag'
            ? el('button', { class: 'btn btn-quiet btn-sm', onclick: () => { closeDrawer('drawer-problems'); searchLogsFor(x.kind === 'lag' ? "Can't keep up" : x.message); } }, icon('search'), 'Show in logs')
            : null,
          x.kind !== 'host' && atLeast('admin') ? el('button', { class: 'btn btn-quiet btn-sm', onclick: (e) => muteProblem(x, e.currentTarget) }, icon('mute'), 'Mute') : null))))
      : [el('li', { class: 'problems-empty' }, el('span', { class: 'problem-icon ok' }, icon('check')), el('div', {}, el('b', {}, 'No problems found. '), `Nothing went wrong in the last ${problemDays === 1 ? '24 hours' : '7 days'}.`))]));
    if (problemDays === 1) renderProblemsBadge({ unseen });
  } catch (e) {
    $('pr-list').replaceChildren(el('li', { class: 'problems-empty' }, `Can't read the logs: ${e.message}`));
  }
}


// ---------------------------------------------------------------------------
// Insights: spark profiler
// ---------------------------------------------------------------------------

let sparkTimer = null;
const sparkLabel = (k) => (k === 'health' ? 'Health report' : 'Profile');

async function loadSpark() {
  clearTimeout(sparkTimer);
  try {
    const st = await api('GET', '/api/spark');
    $('spark-panel').hidden = false;
    const actions = $('spark-actions');
    if (!st.installed) {
      $('spark-info').textContent = 'Install spark, the standard Minecraft profiler, to see which plugin, mod or chunk causes lag. It is free and runs on Paper, Fabric and Forge.';
      actions.replaceChildren(el('button', { class: 'btn btn-primary btn-sm', onclick: (e) => busy(e.currentTarget, async () => {
        try {
          await api('POST', '/api/plugins', { projectId: 'spark', title: 'spark' });
          toast('spark installed. It loads at the next restart.');
          loadSpark();
        } catch (err) {
          toast(err.message, 'bad');
        }
      }) }, icon('download'), 'Install spark'));
      $('spark-links').hidden = true;
      return;
    }
    const run = st.running;
    $('spark-info').textContent = run
      ? `${sparkLabel(run.kind)} running${run.kind === 'profile' ? `, about ${Math.max(0, Math.round((run.endsAt - Date.now()) / 1000))} s left` : ''}. The link appears here when spark has uploaded it.`
      : 'spark records what the server spends its time on and opens it in its web viewer.';
    const start = (kind) => (e) => busy(e.currentTarget, async () => {
      try {
        await api('POST', '/api/spark', { kind, seconds: 30 });
        loadSpark();
      } catch (err) {
        toast(err.message, 'bad');
      }
    });
    actions.replaceChildren(
      el('button', { class: 'btn btn-sm', disabled: run || undefined, onclick: start('health') }, 'Health report'),
      el('button', { class: 'btn btn-primary btn-sm', disabled: run || undefined, onclick: start('profile') }, icon('insights'), run?.kind === 'profile' ? 'Profiling…' : 'Profile 30 s'));
    const links = st.activity.slice(0, 5);
    $('spark-links').hidden = !links.length;
    $('spark-links').replaceChildren(...links.map((a) => el('li', {},
      el('span', { class: 'pill' }, a.type),
      el('a', { href: a.url, target: '_blank', rel: 'noopener' }, a.url.replace('https://', '')),
      el('span', { class: 'note' }, a.time ? fmt.relative(new Date(a.time).toISOString()) : ''))));
    if (st.last && Date.now() - st.last.at < 15000) toast(`spark ${sparkLabel(st.last.kind).toLowerCase()} is ready.`);
    if (run && currentView('insights') === 'metrics') sparkTimer = setTimeout(loadSpark, 3000);
  } catch {
    $('spark-panel').hidden = true;
  }
}


$('pr-range').addEventListener('click', (e) => {
  const b = e.target.closest('[data-days]');
  if (!b) return;
  problemDays = Number(b.dataset.days);
  for (const x of $('pr-range').children) x.setAttribute('aria-checked', String(x === b));
  loadProblems();
});
$('pr-seen').addEventListener('click', async (e) => {
  await busy(e.currentTarget, () => api('POST', '/api/problems/seen'));
  renderProblemsBadge(null);
  loadProblems();
});

function searchPlayerLogs(name) {
  const f = $('ls-form').elements;
  $('ls-form').reset();
  f.player.value = name;
  showTab('insights/logs');
  searchLogsUi();
}

// ---------------------------------------------------------------------------
// Insights: audit
// ---------------------------------------------------------------------------

function fillSelect(select, values, allLabel) {
  const cur = select.value;
  select.replaceChildren(el('option', { value: '' }, allLabel), ...values.map((v) => el('option', { value: v, selected: v === cur || undefined }, v)));
}

let auditTimer;
async function loadAudit() {
  const f = $('au-form').elements;
  const params = new URLSearchParams();
  for (const k of ['user', 'action', 'q']) if (f[k].value.trim()) params.set(k, f[k].value.trim());
  if (f.failed.checked) params.set('failed', '1');
  try {
    const r = await api('GET', `/api/audit?${params}`);
    fillSelect(f.user, r.users, 'Everyone');
    fillSelect(f.action, r.actions, 'All actions');
    $('au-list').replaceChildren(...(r.entries.length
      ? r.entries.map((e) => el('tr', { class: e.ok ? null : 'failed' },
          el('td', { 'data-label': 'When', class: 'nowrap', title: fmt.relative(e.at) }, fmt.date(e.at)),
          el('td', { class: 'primary-cell', 'data-label': 'User', title: e.ip || '' }, e.user || '–', e.ip ? el('span', { class: 'inline-sub mono' }, e.ip) : null),
          el('td', { 'data-label': 'Action' }, el('span', { class: `pill ${e.ok ? '' : 'bad'}` }, e.ok ? null : icon('alert'), e.action)),
          el('td', { 'data-label': 'Details' },
            e.target ? el('span', { class: 'mono-cell' }, e.target) : null,
            e.error ? el('span', { class: 'sub bad' }, e.error) : null)))
      : [emptyRow(4, r.total ? 'Nothing matches these filters.' : 'No actions recorded yet. Every change made through rconsole and every sign-in shows up here.')]));
  } catch (e) {
    $('au-list').replaceChildren(emptyRow(4, `Can't read the audit log: ${e.message}`));
  }
}
viewLoaders['insights/activity'] = loadAudit;
$('au-form').addEventListener('change', loadAudit);
$('au-form').addEventListener('input', (e) => {
  if (e.target.name !== 'q') return;
  clearTimeout(auditTimer);
  auditTimer = setTimeout(loadAudit, 250);
});
$('au-form').addEventListener('submit', (e) => e.preventDefault());

// ---------------------------------------------------------------------------
// Players: history
// ---------------------------------------------------------------------------

// A date cell on one line: the date, and "2 hours ago" as its tooltip.
const when = (iso) => (iso ? el('span', { class: 'when', title: fmt.relative(iso) }, fmt.date(iso)) : '–');
const dur = (ms) => fmt.duration(Math.round(ms / 1000));

function rowActionBtn(label, iconName, command, confirmOpts, danger, after) {
  const btn = el('button', { class: `btn btn-quiet btn-sm${danger ? ' danger' : ''}`, 'data-min-role': roleForCommand(command) }, icon(iconName), label);
  btn.addEventListener('click', async () => {
    if (confirmOpts && !(await confirmAction(confirmOpts))) return;
    await busy(btn, () => mutate(command));
    after?.();
  });
  return btn;
}



// ---------------------------------------------------------------------------
// Players: security (unknown connection attempts, advice)
// ---------------------------------------------------------------------------

const SEEN_KEY = 'rconsole.security.seen';
const seenAt = () => {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
};

function renderSecurityBadge(sec) {
  const fresh = sec?.last && Date.parse(sec.last) > seenAt();
  document.querySelector('.nav [data-tab=players]').classList.toggle('has-alert', Boolean(fresh) || joinPending > 0);
}

function adviceItem(tone, title, body, action) {
  return el('div', { class: `advice-item ${tone}` }, icon(tone === 'ok' ? 'check' : 'alert'),
    el('div', {}, el('b', {}, title), el('p', {}, body)), action || null);
}

const IP_OK = /^[0-9a-fA-F:.]{3,45}$/;

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied.`);
  } catch {
    window.prompt(label, text);
  }
}

async function loadSecurity({ quiet = false } = {}) {
  try {
    localStorage.setItem(SEEN_KEY, String(Date.now()));
  } catch {}
  renderSecurityBadge(null);
  if (!quiet) skeletonRows($('sec-list'), 6);
  try {
    const [h, access, settings] = await Promise.all([api('GET', '/api/players/history'), api('GET', '/api/access'), api('GET', '/api/settings').catch(() => null)]);
    accessCache = access;
    const prop = (key) => {
      const spec = settings?.schema.find((x) => x.key === key);
      return spec ? spec.value ?? spec.default : null;
    };
    const port = settings?.other?.find((o) => o.key === 'server-port')?.value || '25565';
    const pub = h.attempts.filter((a) => !a.private);
    const banned = new Set((access.ipBans || []).map((b) => b.ip));

    const advice = [];
    if (prop('online-mode') === 'false') {
      advice.push(adviceItem('bad', 'Online mode is off', 'Anyone can join under any name, an operator’s included. Turn it on unless a proxy such as Velocity handles sign-ins.',
        el('button', { class: 'btn btn-sm', onclick: () => showTab('server/properties') }, 'Open properties')));
    }
    if (!access.whitelistEnabled) {
      advice.push(adviceItem(pub.length ? 'bad' : 'warn', 'The whitelist is off',
        `Anyone who finds the server can join.${pub.length ? ` ${pub.length} unknown internet address${pub.length === 1 ? '' : 'es'} already tried.` : ''}`,
        el('button', { class: 'btn btn-primary btn-sm', onclick: async (e) => { await busy(e.currentTarget, () => mutate('whitelist on')); loadSecurity({ quiet: true }); } }, 'Turn on whitelist')));
    } else {
      advice.push(adviceItem('ok', 'Whitelist is on', `Unknown visitors are turned away at sign-in.${prop('enforce-whitelist') === 'true' ? '' : ' Tip: also turn on “Kick players removed from the whitelist” under Server → Properties.'}`));
    }
    if (pub.length) {
      advice.push(adviceItem('warn', 'Your server is reachable from the internet',
        `Scanners probe every open server within hours; they come from ever-changing addresses, so banning single ones helps little. If only your own people play, close port ${port} on the router or firewall and reach it over a VPN (WireGuard, Tailscale).`));
    }
    $('sec-advice').replaceChildren(...advice);

    $('sec-info').textContent = h.attempts.length
      ? `${pub.length} internet and ${h.attempts.length - pub.length} local address${h.attempts.length - pub.length === 1 ? '' : 'es'} connected without ever logging in. Mostly scanners looking for open servers.`
      : 'No unknown connection attempts in the logs.';
    $('sec-list').replaceChildren(...(h.attempts.length
      ? h.attempts.map((a) => {
          const safe = IP_OK.test(a.ip);
          const isBanned = banned.has(a.ip);
          return el('tr', {},
            el('td', { class: 'primary-cell', 'data-label': 'Address' }, el('span', { class: 'addr' }, el('span', { class: 'mono' }, a.ip),
              el('span', { class: `pill ${a.private ? '' : 'bad'}` }, a.private ? 'Local network' : 'Internet'),
              isBanned ? el('span', { class: 'pill own' }, icon('ban'), 'Banned') : null)),
            el('td', { 'data-label': 'Names tried' }, a.names.length ? a.names.join(', ') : el('span', { class: 'sub' }, 'none sent')),
            el('td', { class: 'num', 'data-label': 'Attempts' }, String(a.count)),
            el('td', { 'data-label': 'Last seen' }, when(new Date(a.last).toISOString())),
            el('td', { class: 'result', 'data-label': 'Reason' }, a.reasons[0] || '–'),
            el('td', { class: 'act' },
              safe && !isBanned && !a.private ? rowActionBtn('Ban IP', 'ban', `ban-ip ${a.ip} Connection scanner`, { title: `Ban ${a.ip}?`, body: 'The server refuses this address from now on. Scanners often switch addresses, so the whitelist protects you better.', confirm: 'Ban IP', tone: 'danger', icon: 'ban' }, true, () => loadSecurity({ quiet: true })) : null,
              safe && !a.private ? el('button', { class: 'btn btn-quiet btn-sm', title: 'Copy a ufw rule that blocks this address before it reaches Minecraft', onclick: () => copyText(`sudo ufw insert 1 deny from ${a.ip} to any port ${port} proto tcp`, 'Firewall rule') }, icon('copy'), 'Firewall rule') : null));
        })
      : [emptyRow(6, el('b', {}, 'Nothing suspicious. '), 'Connections that never log in show up here, with a way to block them.')]));
  } catch (e) {
    $('sec-list').replaceChildren(emptyRow(6, `Can't read connection attempts: ${e.message}`));
  }
}
viewLoaders['players/addresses'] = loadSecurity;

$('ph-filter').addEventListener('input', renderPeople);
$('pp-filter').addEventListener('click', (e) => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  peopleFilter = b.dataset.f;
  for (const x of $('pp-filter').children) x.setAttribute('aria-checked', String(x === b));
  renderPeople();
});
// One field, three outcomes: whitelist, make operator, ban (with a reason).
$('pp-add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('pp-add').elements.name;
  const name = input.value.trim();
  const act = e.submitter?.value || 'whitelist';
  if (!PLAYER_RE.test(name)) {
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    return toast('Player names are 1–16 letters, digits or underscores.', 'bad');
  }
  let command = act === 'op' ? `op ${name}` : act === 'ban' ? `ban ${name}` : `whitelist add ${name}`;
  if (act === 'ban') {
    const reason = el('input', { class: 'field', maxlength: 120, placeholder: 'Optional', 'aria-label': 'Reason' });
    if (!(await confirmAction({ ...CONFIRM_ADD.ban(name), content: fld('Reason', reason) }))) return;
    if (reason.value.trim()) command += ` ${reason.value.trim()}`;
  } else if (act === 'op' && !(await confirmAction(CONFIRM_ADD.op(name)))) return;
  input.value = '';
  busy(e.submitter || $('pp-add').querySelector('.btn-primary'), () => mutate(command));
});
$('pp-add').elements.name.addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Command palette (Ctrl/Cmd+K): go to any view, run rconsole actions, or pick
// a Minecraft command to fill into the console.
// ---------------------------------------------------------------------------

const palette = $('palette');
const paletteInput = $('palette-input');
const paletteList = $('palette-list');
let paletteItems = [];
let paletteShown = [];
let paletteActive = 0;

function paletteActions() {
  const items = [];
  const views = [...document.querySelectorAll('.area')].flatMap((section) => {
    const area = section.id.slice(4);
    const subs = [...section.querySelectorAll('.subnav [role=tab]')];
    const a = AREAS[area];
    if (!a || (a.hidden && area !== 'servers')) return [];
    return subs.length
      ? subs.filter(allowedHere).map((t) => ({ group: 'Go to', icon: a.icon, label: `${a.name} → ${t.textContent.trim()}`, keys: `${area} ${t.dataset.view}`, run: () => showTab(`${area}/${t.dataset.view}`) }))
      : [{ group: 'Go to', icon: a.icon, label: a.name, keys: area, run: () => showTab(area) }];
  });
  items.push(...views);
  // Actions below admin: only looking things up.
  const SAFE = /^(Show problems|Search the logs|Review unknown connection|Sign out|Refresh the command list|Chat with players)/;
  const act = (label, iconName, keys, run, when = () => true) => (atLeast('admin') || SAFE.test(label)) && when() && items.push({ group: 'Actions', icon: iconName, label, keys, run });
  const p = lastStatus?.power || {};
  act('Restart the server…', 'restart', 'reboot restart power', () => { showTab('server/overview'); power('restart'); }, () => p.available && p.active === 'active');
  act('Stop the server…', 'stop', 'shutdown stop power off', () => { showTab('server/overview'); power('stop'); }, () => p.available && p.active === 'active');
  act('Start the server', 'play', 'start power on boot', () => { showTab('server/overview'); power('start'); }, () => p.available && p.active !== 'active');
  act(lastStatus?.maintenance?.enabled ? 'Turn off maintenance mode' : 'Turn on maintenance mode…', 'maintenance', 'maintenance lock whitelist', () => { showTab('server/overview'); $('maint-toggle').click(); });
  act('Back up the active world', 'backups', 'backup save snapshot', () => { showTab('backups'); $('backup-now').click(); });
  act('Create a new world…', 'worlds', 'new world create generate', () => { showTab('world/worlds'); toggleWorldForm(true); });
  act('Install a new server…', 'server', 'new server install paper fabric velocity create', () => { showTab('servers'); toggleServerForm(true); });
  act('Whitelist a player…', 'add', 'whitelist add player allow', () => { showTab('players/people'); $('pp-add').elements.name.focus(); });
  act('Check for updates', 'updates', 'update upgrade version paper rconsole plugins mods self', () => { showTab('server/updates'); checkAll(true); });
  act('Edit a plugin config…', 'settings', 'config yml yaml edit plugin mod settings file', () => showTab('server/files'));
  act('Check for plugin updates', 'plugins', 'plugin modrinth update', () => { showTab('server/plugins'); loadPlugins(true); });
  act('Find a plugin on Modrinth…', 'plugins', 'install plugin modrinth search add', () => { showTab('server/plugins'); $('plugin-search').elements.q.focus(); });
  act('Profile the server with spark', 'insights', 'spark profiler lag tps cause', () => showTab('insights/metrics'));
  act('Chat with players', 'send', 'chat message say whisper tell talk', () => showTab('console/chat'));
  act('Show problems and errors', 'alert', 'problems errors crash exception plugin failed bell', openProblems);
  act('Review unknown connection attempts', 'ban', 'security scanner ban ip firewall whitelist addresses', () => showTab('players/addresses'));
  act('Search the logs…', 'search', 'logs grep find error', () => { showTab('insights/logs'); $('ls-form').elements.q.focus(); });
  act('Add a scheduled task…', 'schedule', 'cron schedule task timer automation event chain', () => { showTab('automation'); loadTasks().then(() => openTaskForm(null)); });
  act('Refresh the command list from the server', 'refresh', 'commands autocomplete reload plugins', () => loadServerCommands(true).then(() => toast(`${serverCommands?.length || 0} commands from the server.`)));
  act('Sign out', 'signout', 'logout sign out', signOut);
  for (const c of commandCatalog().values()) {
    if (!c.known) continue;
    items.push({ group: 'Minecraft commands', icon: 'console', label: `/${c.name}`, detail: c.alias ? `Alias of /${c.alias}` : c.description, keys: `/${c.name} ${c.description || ''}`, command: true, run: () => fillCommand(c.name) });
  }
  return items;
}

function fillCommand(name) {
  showTab('console');
  cmdInput.value = `${name} `;
  cmdInput.focus();
  updateSuggestions();
}

function scorePalette(item, q) {
  if (!q) return item.command ? -1 : 1;
  const hay = `${item.label} ${item.keys} ${item.detail || ''}`.toLowerCase();
  const label = item.label.toLowerCase();
  let score = 0;
  for (const w of q.split(/\s+/).filter(Boolean)) {
    if (label.startsWith(w) || label.includes(` ${w}`) || label.includes(`/${w}`)) score += 3;
    else if (hay.includes(w)) score += 1;
    else return -1;
  }
  return score;
}

function renderPalette() {
  const raw = paletteInput.value.trim().toLowerCase();
  const commandsOnly = raw.startsWith('/');
  const q = commandsOnly ? raw : raw;
  paletteShown = paletteItems
    .filter((i) => !commandsOnly || i.command)
    .map((i) => ({ i, s: scorePalette(i, q) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 50)
    .map((x) => x.i);
  // Without a query, keep groups in their natural order and skip commands.
  if (!q) paletteShown = paletteItems.filter((i) => !i.command);
  paletteActive = Math.min(paletteActive, Math.max(0, paletteShown.length - 1));
  let group = null;
  const rows = [];
  paletteShown.forEach((item, idx) => {
    if (item.group !== group) {
      group = item.group;
      rows.push(el('li', { class: 'palette-group', role: 'presentation' }, group));
    }
    rows.push(el('li', {
      id: `pal-${idx}`, role: 'option', 'aria-selected': String(idx === paletteActive),
      onmousedown: (e) => { e.preventDefault(); runPalette(idx); },
      onmousemove: () => { if (paletteActive !== idx) { paletteActive = idx; renderPaletteSelection(); } },
    }, icon(item.icon), el('span', { class: 'pal-label' }, item.label), item.detail ? el('span', { class: 'pal-detail' }, item.detail) : null));
  });
  paletteList.replaceChildren(...(rows.length ? rows : [el('li', { class: 'palette-empty' }, 'Nothing matches. Try a Minecraft command with /.')]));
  renderPaletteSelection();
}

function renderPaletteSelection() {
  paletteList.querySelectorAll('[role=option]').forEach((li) => li.setAttribute('aria-selected', String(li.id === `pal-${paletteActive}`)));
  paletteInput.setAttribute('aria-activedescendant', `pal-${paletteActive}`);
  $(`pal-${paletteActive}`)?.scrollIntoView({ block: 'nearest' });
}

function runPalette(idx) {
  const item = paletteShown[idx];
  if (!item) return;
  palette.close();
  item.run();
}

function openPalette(prefill = '') {
  if (palette.open) return;
  if (!serverCommands) loadServerCommands().then(() => { if (palette.open) { catalogCache = null; paletteItems = paletteActions(); renderPalette(); } });
  paletteItems = paletteActions();
  paletteInput.value = prefill;
  paletteActive = 0;
  renderPalette();
  palette.showModal();
  paletteInput.focus();
}

paletteInput.addEventListener('input', () => {
  paletteActive = 0;
  renderPalette();
});
paletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = paletteShown.length || 1;
    paletteActive = (paletteActive + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    renderPaletteSelection();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runPalette(paletteActive);
  }
});
palette.addEventListener('click', (e) => { if (e.target === palette) palette.close(); });
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey) && !e.altKey) {
    e.preventDefault();
    if (palette.open) palette.close();
    else openPalette();
  }
});
$('palette-open').addEventListener('click', () => openPalette());
$('palette-open-m').addEventListener('click', () => openPalette());
if (/Mac|iPhone|iPad/.test(navigator.platform)) $('palette-key').textContent = '⌘K';

// ---------------------------------------------------------------------------
// Notifications (ntfy)
// ---------------------------------------------------------------------------

const notifyForm = $('notify-form');

async function loadNotify() {
  if (!globalAtLeast('admin')) return; // the settings hold the topic and token
  try {
    const n = await api('GET', '/api/notify');
    const f = notifyForm.elements;
    f.url.value = n.url;
    f.url.disabled = n.fromEnv;
    f.token.value = '';
    f.token.placeholder = n.hasToken ? 'Saved; leave empty to keep' : 'tk_… (only for protected topics)';
    f.token.disabled = n.fromEnv;
    $('ntfy-url-note').replaceChildren(n.publicUrl
      ? `Tapping a notification opens the matching page at ${n.publicUrl}.`
      : el('span', { class: 'fact-warn' }, icon('alert'), 'Set the rconsole URL under Settings → System, or notifications can\'t link back here.'));
    f.tpsBelow.value = n.tpsBelow;
    f.tpsMinutes.value = n.tpsMinutes;
    f.quietOn.checked = n.quiet.enabled;
    f.quietFrom.value = n.quiet.from;
    f.quietTo.value = n.quiet.to;
    f.oneTap.checked = n.oneTap;
    f.dcUrl.value = '';
    f.dcUrl.placeholder = n.discord.hasUrl ? 'Saved; paste a new one to replace' : 'https://discord.com/api/webhooks/…';
    f.dcChatUrl.value = '';
    f.dcChatUrl.placeholder = n.discord.hasChatUrl ? 'Saved; paste a new one to replace' : "Another channel's webhook";
    f.dcAlerts.checked = n.discord.alerts && n.discord.hasUrl;
    f.dcChat.checked = n.discord.chat && n.discord.hasChatUrl;
    const prio = (key, value) => el('select', { class: 'field prio', name: `prio-${key}`, 'aria-label': 'Priority' },
      ...Object.entries(n.priorityNames).map(([v, label]) => el('option', { value: v, selected: Number(v) === value || undefined }, label)));
    $('notify-events').replaceChildren(...n.events.map((e) => el('div', { class: 'notify-event' },
      el('label', { class: 'check' }, el('input', { type: 'checkbox', name: `ev-${e.key}`, checked: e.enabled || undefined }), el('span', {}, e.label)),
      prio(e.key, e.priority))));
    const on = [n.url ? 'ntfy' : null, n.discord.hasUrl && n.discord.alerts ? 'Discord' : null].filter(Boolean);
    $('notify-note').textContent = n.fromEnv ? 'Topic and token come from NTFY_URL / NTFY_TOKEN in rconsole.env.' : on.length ? `Alerts go to ${on.join(' and ')}.` : 'Off until an ntfy topic or a Discord webhook is set. Pick a long, unguessable topic name: anyone who knows it can read the alerts.';
    $('ntfy-test').disabled = !on.length;
  } catch (e) {
    $('notify-note').textContent = e.message;
  }
}
viewLoaders['settings/notifications'] = loadNotify;

notifyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = notifyForm.elements;
  const body = {
    events: Object.fromEntries([...notifyForm.querySelectorAll('[name^=ev-]')].map((c) => [c.name.slice(3), c.checked])),
    priorities: Object.fromEntries([...notifyForm.querySelectorAll('[name^=prio-]')].map((c) => [c.name.slice(5), Number(c.value)])),
    quiet: { enabled: f.quietOn.checked, from: f.quietFrom.value || '22:00', to: f.quietTo.value || '07:00' },
    oneTap: f.oneTap.checked,
    tpsBelow: Number(f.tpsBelow.value),
    tpsMinutes: Number(f.tpsMinutes.value),
  };
  if (!f.url.disabled) body.url = f.url.value.trim();
  if (!f.token.disabled && f.token.value) body.token = f.token.value;
  body.discord = { alerts: f.dcAlerts.checked, chat: f.dcChat.checked };
  if (f.dcUrl.value.trim()) body.discord.url = f.dcUrl.value.trim();
  if (f.dcChatUrl.value.trim()) body.discord.chatUrl = f.dcChatUrl.value.trim();
  await busy(notifyForm.querySelector('.btn-primary'), async () => {
    try {
      await api('POST', '/api/notify', body);
      toast('Notification settings saved.');
      loadNotify();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
});
$('ntfy-test').addEventListener('click', (e) => busy(e.currentTarget, () => api('POST', '/api/notify/test').then(() => toast('Test notification sent. Check your phone.')).catch((err) => toast(err.message, 'bad'))));

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

let mapChecked = false;
viewLoaders['world/map'] = async () => {
  if (mapChecked && $('map-iframe').src) return;
  try {
    const m = await api('GET', '/api/map');
    mapChecked = true;
    $('map-frame').hidden = !m.configured;
    $('map-setup').hidden = m.configured;
    if (m.configured) {
      $('map-iframe').src = m.src;
      $('map-open').href = m.src;
      return;
    }
    // A map plugin is already there: offer to show it.
    const found = m.detected || [];
    $('map-found').hidden = !found.length;
    $('map-steps').hidden = Boolean(found.length);
    $('map-found').replaceChildren(...found.map((d) => el('div', { class: 'advice-item info' }, icon('map'),
      el('div', {}, el('b', {}, `${d.plugin} is installed and serves on port ${d.port}.`),
        el('p', {}, d.private
          ? 'It only listens on this machine, so rconsole can show it here behind your sign-in.'
          : [`It listens on every network address (${d.bind}), so anyone who can reach port ${d.port} sees it. After using it here, set `, el('code', {}, d.bindKey), ' in ', el('code', {}, d.config), ' and restart the server.'])),
      atLeast('admin') && !m.fromEnv ? el('button', { class: 'btn btn-primary btn-sm', onclick: (e) => busy(e.currentTarget, async () => {
        try {
          await api('PUT', '/api/map', { url: d.url });
          toast(`Showing ${d.plugin}.`);
          mapChecked = false;
          $('map-iframe').removeAttribute('src');
          viewLoaders['world/map']();
        } catch (err) {
          toast(err.message, 'bad');
        }
      }) }, `Use ${d.plugin}`) : null)));
  } catch {
    $('map-setup').hidden = false;
  }
};
$('map-install').addEventListener('click', () => {
  showTab('server/plugins');
  const f = $('plugin-search');
  f.elements.q.value = 'squaremap';
  f.requestSubmit();
});

// ---------------------------------------------------------------------------
// Phones: "More" sheet for the areas that don't fit the tab bar
// ---------------------------------------------------------------------------

const moreSheet = $('more-sheet');
$('nav-more').addEventListener('click', () => {
  const current = document.body.dataset.area;
  $('more-list').replaceChildren(...Object.entries(AREAS).filter(([key, a]) => !PHONE_TABS.includes(key) && !a.hidden).map(([key, a]) =>
    el('button', { class: `more-item${key === current ? ' on' : ''}`, 'data-tab': key, onclick: () => { moreSheet.close(); showTab(key); } },
      el('span', { class: 'tile' }, icon(a.icon)), a.name)),
    el('button', { class: `more-item${current === 'servers' ? ' on' : ''}`, onclick: () => { moreSheet.close(); showTab('servers'); } }, el('span', { class: 'tile' }, icon('server')), 'Servers'),
    el('button', { class: 'more-item', onclick: () => { moreSheet.close(); openPalette(); } }, el('span', { class: 'tile' }, icon('search')), 'Search & run'),
    el('button', { class: 'more-item', onclick: signOut }, el('span', { class: 'tile' }, icon('signout')), 'Sign out'));
  $('nav-more').setAttribute('aria-expanded', 'true');
  moreSheet.showModal();
});
moreSheet.addEventListener('close', () => $('nav-more').setAttribute('aria-expanded', 'false'));
moreSheet.addEventListener('click', (e) => { if (e.target === moreSheet) moreSheet.close(); });

async function signOut() {
  const r = await fetch('/api/logout', { method: 'POST' }).then((x) => x.json()).catch(() => ({}));
  location.replace(r.redirect || '/login'); // SSO: end the provider session too
}
$('logout').addEventListener('click', signOut);
// Back from linking a local account to the provider (see renderAccount).
if (new URLSearchParams(location.search).has('linked')) {
  history.replaceState(null, '', `/${location.hash}`);
  setTimeout(() => toast('Linked. From now on, sign in with single sign-on.'), 0);
}
api('GET', '/api/me').then(({ user, role, globalRole, server, via, name, auth }) => {
  applyRole(role, globalRole);
  me = { user, role, globalRole, server, via, name, auth };
  if (role === 'none') {
    $('conn').dataset.state = 'down';
    $('status').textContent = 'No access';
  }
  if (document.body.dataset.area === 'settings') renderAccount();
  const sso = via === 'sso' ? auth?.sso?.name || 'SSO' : null;
  $('me-role').textContent = role === 'none' ? 'no access' : role && role !== 'admin' ? role : '';
  $('me').textContent = user;
  $('me').title = sso ? `${name || user}, signed in with ${sso}` : 'Local account';
  $('me-via').toggleAttribute('hidden', !sso); // SVG elements have no .hidden property
  if (sso) {
    $('me-via').setAttribute('aria-label', `Signed in with ${sso}`);
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'title'); // a tooltip inside SVG
    t.textContent = `Signed in with ${sso}`;
    $('me-via').prepend(t);
  }
  $('me-initial').textContent = (name || user || '?').slice(0, 1).toUpperCase();
}).catch(() => {});

// Settings → Account: who you are here, and (admins) how everyone signs in.
const ROLE_TEXT = {
  admin: 'Admins can do everything, including settings, updates and the audit log.',
  moderator: 'Moderators see what admins see and handle players: chat, kick, ban, whitelist, teleport and game mode.',
  viewer: 'Viewers can look at everything but change nothing.',
};
let me = null;
function renderAccount() {
  if (!me) return;
  const row = (k, v) => el('div', {}, el('dt', {}, k), el('dd', {}, v));
  const sso = me.via === 'sso' ? me.auth?.sso?.name || 'SSO' : null;
  const cap = (r) => r[0].toUpperCase() + r.slice(1);
  const global = me.globalRole || me.role;
  $('acct-note').textContent = ROLE_TEXT[me.role] || (me.role === 'none' ? `You have no access to ${me.server?.name}.` : '');
  $('acct-facts').replaceChildren(
    row('Account', me.name ? `${me.name} (${me.user})` : me.user),
    row('Role', cap(global)),
    me.role !== global ? row(`On ${me.server?.name}`, me.role === 'none' ? 'No access' : cap(me.role)) : null,
    row('Signed in with', sso || 'Username and password'),
    row(sso ? 'Password and 2FA' : 'Password', sso ? `Managed in ${sso}` : el('button', { class: 'btn btn-sm', onclick: changePassword }, icon('key'), 'Change password')),
    sso ? null : row('Two-factor sign-in', el('span', {}, 'On the server: ', el('code', {}, `node cli.js user totp ${me.user}`))),
  );
  // A local account can be tied to the provider user once, by signing in there.
  const provider = me.auth?.sso?.name;
  if (!sso && provider) {
    $('acct-facts').append(row(`Sign in with ${provider}`, el('span', {},
      el('a', { class: 'btn', href: '/auth/oidc/start?link=1' }, `Link to ${provider}`),
      el('span', { class: 'note' }, ` Then you sign in to ${me.user} with ${provider}; your password and 2FA here are removed, and your role follows your ${provider} groups.`))));
  }
}

async function changePassword(e) {
  const btn = e.currentTarget;
  const pw = (label, auto) => el('input', { class: 'field', type: 'password', autocomplete: auto, maxlength: 1024, 'aria-label': label });
  const current = pw('Current password', 'current-password');
  const next = pw('New password', 'new-password');
  const again = pw('New password again', 'new-password');
  const content = el('div', { class: 'dialog-form' }, fld('Current password', current), fld('New password (10 characters or more)', next), fld('New password again', again));
  if (!(await confirmAction({ title: 'Change your password', body: 'You stay signed in here; every other device is signed out.', confirm: 'Change password', icon: 'key', content }))) return;
  if (next.value !== again.value) return toast('The new passwords don’t match.', 'bad');
  if (next.value.length < 10) return toast('The new password needs at least 10 characters.', 'bad');
  await busy(btn, async () => {
    try {
      await api('POST', '/api/me/password', { current: current.value, password: next.value });
      toast('Password changed. Other devices are signed out.');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
}

async function loadUsers() {
  if (!globalAtLeast('admin')) return;
  skeletonRows($('users-list'), 4);
  try {
    const { users: list, servers } = await api('GET', '/api/users');
    accessServers = servers;
    $('n-users').textContent = list.length;
    const ssoName = me?.auth?.sso?.name || 'SSO';
    const nameOf = (key) => servers.find((x) => x.key === key)?.name || key;
    $('users-list').replaceChildren(...list.map((u) => {
      const own = Object.entries(u.servers || {});
      return el('tr', {},
        el('td', { class: 'primary-cell', 'data-label': 'Account' }, u.name, u.displayName || u.email ? el('span', { class: 'sub' }, [u.displayName, u.email].filter(Boolean).join(' · ')) : null),
        el('td', { 'data-label': 'Role' }, el('span', { class: `pill${u.role === 'admin' ? ' own' : ''}` }, u.role)),
        el('td', { 'data-label': 'Servers' }, own.length
          ? el('span', { class: 'access-sum' }, ...own.map(([k, r]) => el('span', { class: `pill${r === 'none' ? ' muted' : r === 'admin' ? ' own' : ''}` }, `${nameOf(k)}: ${r === 'none' ? 'no access' : r}`)))
          : el('span', { class: 'sub' }, servers.length > 1 ? 'Same on all' : '–')),
        el('td', { 'data-label': 'Sign-in' }, u.source === 'sso' ? ssoName : `Password${u.totp ? ' + 2FA' : ''}`),
        el('td', { 'data-label': 'Last seen' }, u.lastLogin ? fmt.relative(u.lastLogin) : u.source === 'sso' ? '–' : el('span', { class: 'sub' }, `created ${fmt.relative(u.created)}`)),
        el('td', { class: 'act' }, u.name === me?.user
          ? el('span', { class: 'sub', title: 'Change your own access from another admin account, or with cli.js' }, 'You')
          : el('button', { class: 'btn btn-quiet btn-sm', onclick: () => openAccess(u) }, icon('key'), 'Access')));
    }));
  } catch (e) {
    $('users-list').replaceChildren(emptyRow(6, `Can't list accounts: ${e.message}`));
  }
}

// Settings → Users & sign-in → Access: the account role and per-server roles.
let accessServers = [];
let accessUser = null;
const ACCESS_CHOICES = [['', 'Account role'], ['admin', 'Admin'], ['moderator', 'Moderator'], ['viewer', 'Viewer'], ['none', 'No access']];
function openAccess(u) {
  accessUser = u;
  const f = $('access-form');
  $('drawer-access-title').textContent = `Access for ${u.name}`;
  f.elements.role.value = u.role;
  f.elements.role.disabled = u.source === 'sso';
  $('access-role-note').textContent = u.source === 'sso' ? `${me?.auth?.sso?.name || 'Single sign-on'} sets this role from the account's groups at every sign-in. Per-server roles below stay.` : 'Changing it signs the account out once, so it applies right away.';
  $('access-servers').replaceChildren(...(accessServers.length
    ? accessServers.map((x) => el('label', { class: 'access-row' },
        el('span', {}, el('b', {}, x.name), x.kind === 'proxy' ? el('span', { class: 'sub' }, ' proxy') : null),
        el('select', { class: 'field', name: `srv:${x.key}` }, ...ACCESS_CHOICES.map(([v, label]) => el('option', { value: v, ...(String(u.servers?.[x.key] ?? '') === v ? { selected: true } : {}) }, label)))))
    : [el('p', { class: 'note' }, 'No servers yet.')]));
  $('access-error').textContent = '';
  openDrawer('drawer-access', f.elements.role.disabled ? f.querySelector('.access-row select') : f.elements.role);
}
$('access-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = $('access-form');
  const servers = {};
  for (const sel of f.querySelectorAll('.access-row select')) servers[sel.name.slice(4)] = sel.value || null;
  const body = { servers, ...(f.elements.role.disabled ? {} : { role: f.elements.role.value }) };
  await busy($('access-save'), async () => {
    try {
      await api('PUT', `/api/users/${encodeURIComponent(accessUser.name)}/access`, body);
      closeDrawer('drawer-access');
      toast(`Saved access for ${accessUser.name}.`);
      await loadUsers();
    } catch (err) {
      $('access-error').textContent = err.message;
    }
  });
});

const warnFact = (text) => el('span', { class: 'fact-warn' }, icon('alert'), text);
async function loadAbout() {
  if (!globalAtLeast('admin')) return;
  const row = (k, v) => el('div', {}, el('dt', {}, k), el('dd', {}, v));
  const mono = (v) => el('span', { class: 'mono' }, v);
  const off = (v) => el('span', { class: 'sub' }, v);
  try {
    const a = await api('GET', '/api/about');
    $('about-note').textContent = `Version ${a.version}${a.commit ? ` (${a.commit})` : ''}, running on Node.js ${a.node}.`;
    $('about-facts').replaceChildren(
      row('Version', `${a.version}${a.commit ? ` · ${a.commit}` : ''}`),
      row('Documentation', el('a', { href: 'https://github.com/iamozyth/rconsole#readme', target: '_blank', rel: 'noopener' }, 'README')),
      row('Release notes', el('a', { href: `https://github.com/iamozyth/rconsole/releases/tag/v${a.version}`, target: '_blank', rel: 'noopener' }, `rconsole ${a.version}`)),
      row('Updates', el('a', { href: '#server/updates' }, 'Server → Updates')),
      row('License', el('a', { href: 'https://github.com/iamozyth/rconsole/blob/main/LICENSE', target: '_blank', rel: 'noopener' }, 'PolyForm Strict 1.0.0')));
    sysPublicUrl = a.publicUrl || '';
    const url = sysForms.web.elements.publicUrl;
    if (!sysDirty.has('web')) url.value = sysPublicUrl;
    url.disabled = a.publicUrlFromEnv;
    $('url-here').hidden = a.publicUrlFromEnv;
    $('url-note').textContent = a.publicUrlFromEnv
      ? 'Set with PUBLIC_URL in /etc/rconsole.env.'
      : 'The address people open rconsole at. Single sign-on sends people back to it, and notifications link to it.';
  } catch (e) {
    $('about-note').textContent = e.message;
  }
}

viewLoaders['settings/account'] = renderAccount;
viewLoaders['settings/signin'] = () => { loadSso(); loadUsers(); };
viewLoaders['settings/system'] = () => { loadAbout(); loadSystem(); };

// Settings → System: rconsole's own settings (lib/system.js). A value saved
// here wins over /etc/rconsole.env; each field says where its value comes
// from and can go back to the env file's.
const sysForms = { web: $('sys-web'), security: $('sys-security'), backups: $('sys-backups') };
const SYS_FIELDS = { web: ['webHost', 'webPort', 'trustProxy'], security: ['require2fa'], backups: ['backupKeep', 'backupCompression', 'updateCheck'] };
const sysDirty = new Set();
let sys = null; // the last GET /api/system
let sysPublicUrl = '';
let sysTimer = null;
const TRIAL_KEY = 'rconsole-address-trial';
const sysValueText = (key, v) => {
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'none';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return { require2fa: { off: 'no', admin: 'for admins', all: 'for everyone' }, backupCompression: { auto: 'zstd when installed', gzip: 'gzip' } }[key]?.[v] ?? String(v);
};

function sysSource(key) {
  const v = sys.settings[key];
  const reset = (label, done) => el('button', { type: 'button', class: 'link-btn', onclick: (e) => saveSystem({ reset: [key] }, e.currentTarget, done) }, label);
  if (v.source === 'env') return [`From ${v.env} in /etc/rconsole.env.`];
  if (v.source !== 'saved') return [];
  const fromFile = 'Back to the value in /etc/rconsole.env.';
  if ('set' in v) return v.envSet ? ['Saved here, in place of METRICS_TOKEN. ', reset('Use the env file’s token', fromFile)] : ['Saved here.'];
  return v.envValue !== null
    ? [`Saved here; /etc/rconsole.env says ${sysValueText(key, v.envValue)}. `, reset('Use that', fromFile)]
    : ['Saved here. ', reset(`Back to the default (${sysValueText(key, v.default)})`, 'Back to the default.')];
}

function fillSysForm(name) {
  const f = sysForms[name].elements;
  for (const key of SYS_FIELDS[name]) {
    const { value } = sys.settings[key];
    if (f[key].type === 'checkbox') f[key].checked = value;
    else f[key].value = Array.isArray(value) ? value.join(', ') : value;
  }
}

function renderSystem() {
  for (const name of Object.keys(sysForms)) if (!sysDirty.has(name)) fillSysForm(name);
  for (const node of document.querySelectorAll('.src[data-src]')) node.replaceChildren(...sysSource(node.dataset.src));
  const m = sys.settings.metricsToken;
  $('sys-metrics-state').textContent = m.set ? 'On' : 'Off';
  $('sys-metrics-state').classList.toggle('ok', m.set);
  $('sys-metrics-off').hidden = !m.set;
  $('sys-metrics-new').lastChild.textContent = m.set ? 'New token' : 'Turn on';
  // A proxy in front that isn't trusted yet: one click adds it.
  const proxy = sys.untrustedProxy || (sys.via.forwarded && !sys.via.trusted ? sys.via.address : null);
  const listed = sysForms.web.elements.trustProxy.value.split(',').map((x) => x.trim());
  $('sys-proxy-add').hidden = !proxy || listed.includes(proxy);
  $('sys-proxy-add').textContent = `Add ${proxy}`;
  $('sys-proxy-add').dataset.address = proxy || '';
  const l = sys.listening;
  $('sys-web-note').textContent = sys.fellBack
    ? `The saved address ${sys.fellBack.host}:${sys.fellBack.port} didn't work at start (${sys.fellBack.error}); rconsole listens on ${l.host}:${l.port} from /etc/rconsole.env.`
    : `Listening on ${l.host}:${l.port}. A new address or port is tried first and kept once you reach rconsole there; otherwise it goes back after 3 minutes.`;
  $('sys-web-note').classList.toggle('warn-note', Boolean(sys.fellBack));
  const row = (k, v) => el('div', {}, el('dt', {}, k), el('dd', {}, v));
  const mono = (v) => el('span', { class: 'mono' }, v);
  const fx = sys.fixed;
  $('env-facts').replaceChildren(
    row('Server folder (MC_DIR)', mono(fx.mcDir)),
    row('Installed servers (SERVERS_DIR)', mono(fx.serversDir)),
    row('Backup folder (BACKUP_DIR)', mono(fx.backupDir)),
    row('rconsole data', mono(fx.stateDir)),
    row('Server service (MC_SERVICE)', mono(fx.mcService)),
    row('Jobs run as (JOB_RUNNER)', fx.jobRunner === 'systemd' ? 'systemd units' : el('span', { class: 'sub' }, 'in-process (development)')),
    row('RCON firewall (RCON_FIREWALL)', fx.rconFirewall ? 'On' : warnFact('Off: RCON ports are reachable from other machines')),
    row('Signed updates (SELF_UPDATE_SIGNERS)', fx.signedUpdates ? 'On' : el('span', { class: 'sub' }, 'Off')));
  renderTrial();
}

async function loadSystem() {
  if (!globalAtLeast('admin')) return;
  try {
    sys = await api('GET', '/api/system');
    renderSystem();
  } catch (e) {
    $('sys-web-note').textContent = `Can't load the settings: ${e.message}`;
  }
}

// The token of a running address trial: only this browser knows it.
const trialToken = () => {
  try {
    const t = JSON.parse(sessionStorage.getItem(TRIAL_KEY) || 'null');
    return t && t.expiresAt > Date.now() ? t.token : null;
  } catch {
    return null;
  }
};

function trialLink(t, token) {
  const wild = ['0.0.0.0', '::'].includes(t.host);
  const host = wild ? location.hostname : t.host.includes(':') ? `[${t.host}]` : t.host;
  return `http://${host}:${t.port}/confirm-address#${token}`;
}

function renderTrial() {
  clearInterval(sysTimer);
  const t = sys?.trial;
  $('sys-trial').hidden = !t;
  if (!t) return;
  const token = trialToken();
  const open = $('sys-trial-open');
  open.hidden = !token;
  if (token) open.href = trialLink(t, token);
  $('sys-trial-title').textContent = `Trying ${t.host}:${t.port}`;
  const l = sys.listening;
  let polling = false;
  const tick = async () => {
    const left = Math.max(0, Math.round((t.expiresAt - Date.now()) / 1000));
    $('sys-trial-body').textContent = `${t.swap ? `${l.host}:${l.port} is closed meanwhile. ` : `rconsole listens there too. `}Open the new address to keep it${token ? '' : ' (from the browser that saved it)'}, or point your reverse proxy at port ${t.port}: this page confirms on its own once it reaches rconsole there. Otherwise rconsole goes back to ${l.host}:${l.port} in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`;
    if (!left) {
      clearInterval(sysTimer);
      setTimeout(loadSystem, 1500);
      return;
    }
    if (!token || polling) return;
    polling = true;
    try {
      const res = await fetch('/api/system/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      if (res.ok || res.status === 404) {
        clearInterval(sysTimer);
        try { sessionStorage.removeItem(TRIAL_KEY); } catch {}
        if (res.ok) toast(`rconsole now listens on ${t.host}:${t.port}.`);
        loadSystem();
      }
    } catch {} finally {
      polling = false;
    }
  };
  tick();
  sysTimer = setInterval(tick, 3000);
}

// Saves a change; asks first when the server warns it could shut someone out.
async function saveSystem(body, button, done = 'Saved.') {
  await busy(button, async () => {
    try {
      let r;
      try {
        r = await api('PUT', '/api/system', body);
      } catch (e) {
        if (!['2fa', 'proxy'].includes(e.data?.confirm)) throw e;
        if (!(await confirmAction({ title: e.data.confirm === '2fa' ? 'Some accounts have no two-factor sign-in' : 'Stop trusting your proxy?', body: e.message, confirm: 'Save anyway', tone: 'danger' }))) return;
        r = await api('PUT', '/api/system', { ...body, confirm: true });
      }
      if (r.trial) {
        try { sessionStorage.setItem(TRIAL_KEY, JSON.stringify({ token: r.trial.token, expiresAt: r.trial.expiresAt })); } catch {}
        toast(`Trying ${r.trial.host}:${r.trial.port}. Open it to keep it.`);
      } else toast(done);
      sys = r;
      for (const name of Object.keys(sysForms)) if (sysForms[name].contains(button)) sysDirty.delete(name);
      renderSystem();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
}

// Only the fields that differ from what applies now.
function sysChanges(name) {
  const f = sysForms[name].elements;
  const set = {};
  for (const key of SYS_FIELDS[name]) {
    const cur = sys.settings[key].value;
    let v = f[key].type === 'checkbox' ? f[key].checked : f[key].value.trim();
    if (Array.isArray(cur)) v = v.split(',').map((x) => x.trim()).filter(Boolean);
    else if (typeof cur === 'number' && v !== '') v = Number(v);
    if (JSON.stringify(v) !== JSON.stringify(cur)) set[key] = v;
  }
  return set;
}

for (const [name, form] of Object.entries(sysForms)) {
  form.addEventListener('input', () => sysDirty.add(name));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = e.submitter || form.querySelector('.form-actions .btn-primary');
    if (!sys) return;
    const set = sysChanges(name);
    if (name === 'web') {
      const url = form.elements.publicUrl;
      if (!url.disabled && url.value.trim() !== sysPublicUrl) {
        try {
          await api('POST', '/api/notify', { publicUrl: url.value.trim() });
          sysPublicUrl = url.value.trim();
          if (!Object.keys(set).length) {
            sysDirty.delete(name);
            return toast('rconsole URL saved.');
          }
        } catch (err) {
          return toast(err.message, 'bad');
        }
      }
    }
    if (!Object.keys(set).length) {
      sysDirty.delete(name);
      return toast('Nothing changed.');
    }
    await saveSystem({ set }, button);
  });
}

$('url-here').addEventListener('click', () => {
  sysForms.web.elements.publicUrl.value = location.origin;
  sysDirty.add('web');
});
$('sys-proxy-add').addEventListener('click', (e) => {
  const f = sysForms.web.elements.trustProxy;
  f.value = [...f.value.split(',').map((x) => x.trim()).filter(Boolean), e.currentTarget.dataset.address].join(', ');
  sysDirty.add('web');
  e.currentTarget.hidden = true;
});
$('sys-trial-cancel').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  try {
    await api('DELETE', '/api/system/trial');
    try { sessionStorage.removeItem(TRIAL_KEY); } catch {}
    toast('Address change cancelled.');
  } catch (err) {
    toast(err.message, 'bad');
  }
  loadSystem();
}));
$('sys-metrics-new').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  if (sys?.settings.metricsToken.set && !(await confirmAction({ title: 'Replace the metrics token?', body: 'Scrapers using the current token get 401 until you give them the new one.', confirm: 'Replace' }))) return;
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await saveSystem({ set: { metricsToken: token } }, button, 'Metrics on. Copy the token now: it isn’t shown again.');
  if (sys?.settings.metricsToken.set) {
    $('sys-token').value = token;
    $('sys-token-row').hidden = false;
  }
});
$('sys-token-copy').addEventListener('click', () => copyText($('sys-token').value, 'Token'));
$('sys-metrics-off').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  if (!(await confirmAction({ title: 'Turn off /metrics?', body: 'Prometheus gets 404 until you turn it on again with a new token.', confirm: 'Turn off', tone: 'danger' }))) return;
  $('sys-token-row').hidden = true;
  // Off over a METRICS_TOKEN in the env file needs a saved empty one.
  await saveSystem(sys.settings.metricsToken.envSet ? { set: { metricsToken: '' } } : { reset: ['metricsToken'] }, button, 'Metrics off.');
});
$('acct-signout').addEventListener('click', () => signOut());

// Settings → Account → Single sign-on: set up, test and switch on, no restart.
const ssoForm = $('sso-form');
let ssoDirty = false;

function showSsoFields() {
  $('sso-fields').hidden = !ssoForm.elements.enabled.checked;
}

async function loadSso() {
  if (!globalAtLeast('admin')) return;
  try {
    const v = await api('GET', '/api/sso');
    renderSsoState(v);
    if (ssoDirty) return;
    const f = ssoForm.elements;
    f.enabled.checked = v.enabled;
    f.issuer.value = v.issuer || '';
    f.clientId.value = v.clientId || '';
    f.clientSecret.value = '';
    f.clientSecret.placeholder = v.hasSecret ? 'Saved; leave empty to keep' : '';
    f.name.value = v.name === 'SSO' ? '' : v.name;
    f.sessionHours.value = v.sessionHours;
    for (const r of ['admin', 'moderator', 'viewer']) f[r].value = v.groups[r].join(', ');
    f.localLogin.checked = v.localLogin;
    f.publicUrl.value = v.publicUrl || '';
    // Set in /etc/rconsole.env: shown, locked.
    const lock = { issuer: 'issuer', clientId: 'clientId', clientSecret: 'clientSecret', name: 'name', sessionHours: 'sessionHours', admin: 'admin', moderator: 'moderator', viewer: 'viewer', localLogin: 'localLogin' };
    for (const [field, key] of Object.entries(lock)) {
      f[field].disabled = Boolean(v.fromEnv[key]);
      f[field].title = v.fromEnv[key] ? 'Set in /etc/rconsole.env' : '';
    }
    f.enabled.disabled = Boolean(v.fromEnv.issuer);
    showSsoFields();
  } catch (e) {
    $('sso-msg').textContent = e.message;
  }
}

function renderSsoState(v) {
  $('sso-state').textContent = v.active ? 'On' : v.enabled ? 'Not working' : 'Off';
  $('sso-state').className = `pill${v.active ? ' ok' : v.enabled ? ' bad' : ''}`;
  $('sso-note').textContent = v.active
    ? `People sign in with ${v.name}; their groups there decide their role here.${v.localLogin ? ' Local accounts still work as a fallback.' : ' Local accounts are off.'}`
    : v.enabled && v.error
      ? `Single sign-on is set up but not working: ${v.error}.`
      : 'Let people sign in with authentik, Keycloak, Auth0 or another OpenID Connect provider. Their groups there decide their role here.';
  $('sso-redirect').value = v.redirectUri || 'Set the rconsole URL first';
  $('sso-copy').disabled = !v.redirectUri;
  $('sso-url-row').hidden = Boolean(v.publicUrlFromEnv); // set on the server: nothing to edit here
  ssoForm.elements.localLogin.closest('.fld').querySelector('.note').textContent = v.youUseSso
    ? 'Keep this on as a way in when the provider is down.'
    : `Keep this on as a way in when the provider is down. It can only be turned off from a session signed in with ${v.name || 'single sign-on'}.`;
}

ssoForm.addEventListener('input', () => { ssoDirty = true; });
ssoForm.elements.enabled.addEventListener('change', showSsoFields);
$('sso-here').addEventListener('click', () => {
  ssoForm.elements.publicUrl.value = location.origin;
  ssoDirty = true;
  $('sso-redirect').value = `${location.origin}/auth/oidc/callback`;
  $('sso-copy').disabled = false;
});
ssoForm.elements.publicUrl.addEventListener('input', (e) => {
  const u = e.target.value.trim().replace(/\/+$/, '');
  $('sso-redirect').value = /^https?:\/\/\S+$/.test(u) ? `${u}/auth/oidc/callback` : 'Set the rconsole URL first';
  $('sso-copy').disabled = !/^https?:\/\/\S+$/.test(u);
});
$('sso-copy').addEventListener('click', () => copyText($('sso-redirect').value, 'Redirect URI'));
ssoForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = ssoForm.elements;
  const body = { enabled: f.enabled.checked };
  if (f.enabled.checked) {
    Object.assign(body, {
      issuer: f.issuer.value.trim(), clientId: f.clientId.value.trim(), name: f.name.value.trim(), sessionHours: Number(f.sessionHours.value) || 12,
      groups: { admin: f.admin.value, moderator: f.moderator.value, viewer: f.viewer.value }, localLogin: f.localLogin.checked,
    });
    if (f.clientSecret.value) body.clientSecret = f.clientSecret.value;
    if (!$('sso-url-row').hidden && f.publicUrl.value.trim()) body.publicUrl = f.publicUrl.value.trim();
    for (const k of Object.keys(body)) if (f[k]?.disabled) delete body[k]; // set on the server
  }
  $('sso-msg').textContent = f.enabled.checked ? 'Checking the provider…' : '';
  await busy(e.submitter || ssoForm.querySelector('.btn-primary'), async () => {
    try {
      const v = await api('PUT', '/api/sso', body);
      ssoDirty = false;
      $('sso-msg').textContent = '';
      toast(v.active ? `Single sign-on with ${v.name} is on. Try it in a private window before you sign out.` : 'Single sign-on is off.');
      await loadSso();
      api('GET', '/api/me').then((m) => { me = m; renderAccount(); }).catch(() => {});
    } catch (err) {
      $('sso-msg').textContent = err.message;
    }
  });
});

// No access to the shown server: the servers this account may see instead.
// Showing one switches rconsole for everyone, so it needs admin there.
tabLoaders.noaccess = async () => {
  await loadServerList();
  const here = me?.server?.name || 'this server';
  $('noaccess-title').textContent = `No access to ${here}`;
  $('noaccess-note').textContent = `Your account has no role on ${here}, the server rconsole shows right now.${serversList.length ? ' You can use these servers:' : ' Ask an admin for access.'}`;
  $('noaccess-list').replaceChildren(...serversList.filter((s) => s.kind === 'server').map((s) => el('li', {},
    el('span', { class: 'sw-item-text' }, el('b', {}, s.name), el('span', { class: 'sub' }, `${s.myRole} · ${s.distribution} ${s.version}`)),
    s.myRole === 'admin' ? serverButton('Show', 'server', (b) => showServer(s, b)) : el('span', { class: 'note' }, 'An admin of it can show it'))));
};

connectLogs();
refreshStatus();
showTab(location.hash.slice(1));
syncTaskForm();
loadServerList().then(renderSwitcher);

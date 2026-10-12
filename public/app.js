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
  insights: { name: 'Insights', icon: 'insights' },
  map: { name: 'Map', icon: 'map' },
};
// On phones the tab bar shows the first four; the rest live under "More".
const PHONE_TABS = 4;
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
  $('nav-more').classList.toggle('on', Object.keys(AREAS).indexOf(name) >= PHONE_TABS);
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
  renderPlatform(s.platform);
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
  renderSelfSummary(s.self);
}

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
  chip.replaceChildren(el('b', {}, pf.name), pf.mcVersion ? ` ${pf.mcVersion}` : '', pf.build ? el('small', {}, ` #${pf.build}`) : '');
  chip.title = [`${pf.name}${pf.mcVersion ? ` on Minecraft ${pf.mcVersion}` : ''}`, pf.build ? `build ${pf.build}` : null, pf.loaderVersion ? `loader ${pf.loaderVersion}` : null,
    pf.addons ? `loads ${pf.addons}s` : 'no plugins or mods', pf.updates ? 'updated by rconsole' : 'updated by hand'].filter(Boolean).join(' · ');
  const tab = document.querySelector('#tab-server .subnav [data-view=plugins]');
  tab.hidden = !pf.addons;
  tab.textContent = pf.addons === 'mod' ? 'Mods' : 'Plugins';
  const kind = pf.addons === 'mod' ? 'mod' : 'plugin';
  $('plugins-title').textContent = `Installed ${kind}s`;
  $('plugin-search').elements.q.placeholder = kind === 'mod' ? 'Search mods, e.g. lithium' : 'Search plugins, e.g. squaremap';
  $('modrinth-note').textContent = `Only ${kind}s for your Minecraft version that run on ${pf.name} are offered. Downloads are checked against Modrinth's SHA-512.`;
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
    accessCache = a;
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
  $('pending-list').textContent = items.length ? `${items.length} change${items.length === 1 ? '' : 's'} wait for the next start: ${items.join(', ')}.` : '';
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
viewLoaders['server/settings'] = loadSettings;

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
            p.error ? el('span', { class: 'pill bad' }, icon('alert'), p.error) : null),
          el('span', { class: 'sub' }, meta || p.file),
          p.description ? el('span', { class: 'sub clamp' }, p.description) : null))),
    el('td', { 'data-label': 'Source' }, p.modrinth
      ? el('a', { class: 'link', href: `https://modrinth.com/plugin/${encodeURIComponent(p.modrinth.slug || p.modrinth.projectId)}`, target: '_blank', rel: 'noopener' }, 'Modrinth')
      : el('span', { class: 'sub' }, 'Unknown source')),
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
    $('plugins-info').textContent = o.remoteError
      ? `${o.plugins.length} jar${o.plugins.length === 1 ? '' : 's'}. Can't reach Modrinth: ${o.remoteError}`
      : `${o.plugins.length} jar${o.plugins.length === 1 ? '' : 's'} for Minecraft ${o.gameVersion || '?'}${updates ? `, ${updates} update${updates === 1 ? '' : 's'} available` : ''}. Changes apply on the next start.`;
    if (refresh) toast(o.remoteError ? `Couldn't check Modrinth: ${o.remoteError}` : updates ? `${updates} update${updates === 1 ? '' : 's'} available.` : 'All Modrinth plugins are up to date.', o.remoteError ? 'bad' : 'ok');
    $('plugin-list').replaceChildren(...(o.plugins.length
      ? o.plugins.map(pluginRow)
      : [emptyRow(4, el('b', {}, 'No plugins yet. '), 'Search Modrinth below to add one; squaremap gives you a live web map.')]));
  } catch (e) {
    $('plugin-list').replaceChildren(emptyRow(4, `Can't list plugins: ${e.message}`));
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
              el('div', {}, el('a', { class: 'link', href: `https://modrinth.com/plugin/${encodeURIComponent(r.slug)}`, target: '_blank', rel: 'noopener' }, r.title), el('span', { class: 'sub clamp' }, r.description)))),
            el('td', { 'data-label': 'Author' }, r.author),
            el('td', { class: 'num', 'data-label': 'Downloads' }, new Intl.NumberFormat(undefined, { notation: 'compact' }).format(r.downloads)),
            el('td', { class: 'act' }, r.installed
              ? el('span', { class: 'pill own' }, icon('check'), 'Installed')
              : pluginButton('Install', 'download', async (b) => {
                  if (!(await confirmAction({ title: `Install ${r.title}?`, body: `The newest release for this server is downloaded from Modrinth, checked, and loaded on the next start.`, confirm: 'Install', icon: 'plugins' }))) return;
                  if (await pluginJob(b, 'POST', '/api/plugins', { projectId: r.id }, (x) => `Installed ${x.file}. Restart to apply.`)) b.closest('td').replaceChildren(el('span', { class: 'pill own' }, icon('check'), 'Installed'));
                }, { primary: true }))))
        : [emptyRow(4, `Nothing on Modrinth matches “${q}” for this server.`)]));
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
});

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
    const name = o.platform?.name || 'Server';
    for (const id of ['upd-builds', 'upd-versions']) $(id).closest('.panel').hidden = !o.supported;
    document.querySelector('.update-options').hidden = !o.supported && !o.canRollback;
    $('upd-backup').closest('label').hidden = !o.supported;
    $('upd-current').textContent = o.current ? `${name} ${o.current.version}${o.current.build ? ` · build ${o.current.build}` : o.platform?.loaderVersion ? ` · loader ${o.platform.loaderVersion}` : ''}` : name;
    if (!o.supported) {
      $('upd-channel').hidden = true;
      $('upd-source').textContent = `rconsole updates Paper and Folia automatically. Update ${name} by hand (new server jar or loader), then restart here.`;
      $('upd-rollback').hidden = !o.canRollback;
      renderUpdateState(o.state);
      return;
    }
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
            onclick: () => startUpdate({ version: o.current.version, build: b.id }, { title: `Update to build ${b.id}?`, body: `${name} ${o.current.version} #${o.current.build} → #${b.id} (${(b.channel || '').toLowerCase()}). The previous jar is kept for rollback.`, confirm: 'Update', icon: 'updates' }),
          }, icon('updates'), 'Update'))))
      : [emptyRow(4, o.current ? [el('b', {}, 'You are on the latest build. '), `${name} ${o.current.version} #${o.current.build}.`] : 'No version information yet.')]));

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
viewLoaders['server/updates'] = () => { loadUpdates(); loadSelfUpdate(); };
// ---------------------------------------------------------------------------
// rconsole's own updates
// ---------------------------------------------------------------------------

let selfWasRunning = false;
let selfVersion = null;

function renderSelfSummary(self) {
  if (!self) return;
  if (selfVersion && self.current && self.current !== selfVersion && !self.running) {
    // A new version is serving; reload to get its frontend.
    toast(`rconsole updated to ${self.current}. Reloading…`);
    setTimeout(() => location.reload(), 1200);
  }
  selfVersion = self.current || selfVersion;
  $('rail-ver').textContent = self.current ? self.current : '';
  $('rail-update').hidden = !self.available && !self.running;
  document.querySelector('.nav [data-tab=server]').classList.toggle('has-update', Boolean(self.available));
  $('rail-update-text').textContent = self.running ? 'Updating rconsole…' : `${self.available} update${self.available === 1 ? '' : 's'} for rconsole`;
  if (selfWasRunning && !self.running && document.body.dataset.area === 'server') loadSelfUpdate();
  selfWasRunning = self.running;
}

async function loadSelfUpdate(refresh) {
  const btn = $('self-refresh');
  btn.setAttribute('aria-busy', 'true');
  try {
    const o = await api('GET', `/api/self-update${refresh ? '?refresh' : ''}`);
    const c = o.check || {};
    $('self-current').textContent = o.current ? `${o.current.sha}${o.current.branch ? ` on ${o.current.branch}` : ''}` : 'Unknown version';
    const behind = c.status === 'ahead' ? c.behind : 0;
    $('self-pill').hidden = !o.current || Boolean(c.error && !c.status);
    $('self-pill').className = `pill ${behind ? 'own' : ''}`;
    $('self-pill').replaceChildren(icon(behind ? 'updates' : 'check'), behind ? `${behind} new commit${behind === 1 ? '' : 's'}` : c.status === 'diverged' ? 'Diverged from GitHub' : 'Up to date');
    $('self-info').textContent = c.error
      ? c.error
      : `From github.com/${o.repo} (${o.branch}). Checked ${fmt.relative(c.at)}; rconsole checks every 6 hours.`;
    // Only a status about the installed version is news: a finished update
    // must have ended on it, a failed one must have started from it.
    const cur = o.current?.sha || '';
    const u = o.update && cur && (o.update.state === 'running' || String(o.update.state === 'done' ? o.update.to : o.update.from).startsWith(cur)) ? o.update : null;
    if (u?.state === 'running') setJob($('self-status'), 'running', 'updates', `${u.message}…`);
    else if (u?.state === 'failed' && Date.now() - Date.parse(u.at) < 7 * 86400000) setJob($('self-status'), 'failed', 'alert', `Last update failed: ${u.message}`);
    else if (u?.state === 'done' && u.from !== u.to && Date.now() - Date.parse(u.at) < 86400000) {
      setJob($('self-status'), 'done', 'check', `${u.message} ${fmt.relative(u.at)}.${u.manual?.length ? ` Manual step: ${u.manual.join('; ')}` : ''}${u.installed?.length ? ` Installed: ${u.installed.join(', ')}.` : ''}`);
    } else setJob($('self-status'), null);
    $('self-changes').hidden = !behind;
    $('self-changes').replaceChildren(...(c.commits || []).map((x) => el('li', {},
      el('a', { class: 'mono', href: `https://github.com/${o.repo}/commit/${x.sha}`, target: '_blank', rel: 'noopener' }, x.sha),
      el('span', {}, x.message),
      x.date ? el('span', { class: 'note' }, fmt.relative(x.date)) : null)));
    $('self-update').hidden = !behind;
    $('self-note').hidden = !behind;
    $('self-update').disabled = !o.canUpdate || u?.state === 'running';
    $('self-update').title = o.canUpdate ? '' : 'Needs the systemd install (see README)';
    if (refresh) toast(c.error ? `Couldn't check: ${c.error}` : behind ? `${behind} new commit${behind === 1 ? '' : 's'} for rconsole.` : 'rconsole is up to date.', c.error ? 'bad' : 'ok');
  } catch (e) {
    $('self-info').textContent = e.message;
  } finally {
    btn.removeAttribute('aria-busy');
  }
}

$('self-refresh').addEventListener('click', () => loadSelfUpdate(true));
$('self-update').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (!(await confirmAction({
    title: 'Update rconsole?',
    body: 'rconsole restarts and everyone is signed out. This page reloads by itself when the new version is up. Minecraft is not affected.',
    confirm: 'Update rconsole', icon: 'updates',
  }))) return;
  await busy(btn, async () => {
    try {
      await api('POST', '/api/self-update');
      setJob($('self-status'), 'running', 'updates', 'Updating rconsole. This page reloads when it is back…');
      btn.disabled = true;
      waitForComeback();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
});

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
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
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
    const H = 168;
    const L = 44, R = 10, T = 10, B = 24;
    charts.get(box).width = W;
    const all = o.series.flatMap((s) => s.values).filter((v) => v != null);
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
    o.series.forEach((s, si) => {
      let d = '';
      let fill = '';
      let seg = [];
      const flush = () => {
        if (seg.length) fill += `M${seg[0][0]},${y(0)}L${seg.map((p) => p.join(',')).join('L')}L${seg[seg.length - 1][0]},${y(0)}Z`;
        seg = [];
      };
      o.t.forEach((t, i) => {
        const v = s.values[i];
        if (v == null) return flush();
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
    const dots = o.series.map((s) => svgEl('circle', { r: 3.5, class: `dot ${s.cls || ''}`, visibility: 'hidden' }));
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
      o.series.forEach((s, si) => {
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
    if (o.series.length > 1 && !box.querySelector('.legend')) {
      box.append(el('div', { class: 'legend' }, ...o.series.map((s) => el('span', { class: s.cls || '' }, el('i'), s.label))));
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
    lineChart($('mc-mem'), { ...base, label: 'Memory', max: 1, yFmt: pct, series: [{ values: m.mem, label: 'Host used', fmt: pct }] });
    statList('ms-mem', [['Host', lastOf(m.mem) != null ? pct(lastOf(m.mem)) : '–'], ['Minecraft RSS', lastOf(m.rss) != null ? fmt.bytes(lastOf(m.rss)) : '–']]);
  } catch (e) {
    $('m-info').textContent = `Can't load metrics: ${e.message}`;
  }
}
viewLoaders['insights/metrics'] = loadMetrics;

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
            el('time', { datetime: new Date(x.t).toISOString(), title: x.file }, new Date(x.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })),
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
          el('td', { 'data-label': 'When' }, fmt.date(e.at), el('span', { class: 'sub' }, fmt.relative(e.at))),
          el('td', { class: 'primary-cell', 'data-label': 'User' }, e.user || '–', e.ip ? el('span', { class: 'sub mono' }, e.ip) : null),
          el('td', { 'data-label': 'Action' }, el('span', { class: `pill ${e.ok ? '' : 'bad'}` }, e.ok ? null : icon('alert'), e.action)),
          el('td', { 'data-label': 'Details' },
            e.target ? el('span', { class: 'mono-cell' }, e.target) : null,
            e.error ? el('span', { class: 'sub bad' }, e.error) : null)))
      : [emptyRow(4, r.total ? 'Nothing matches these filters.' : 'No actions recorded yet. Every change made through rconsole and every sign-in shows up here.')]));
  } catch (e) {
    $('au-list').replaceChildren(emptyRow(4, `Can't read the audit log: ${e.message}`));
  }
}
viewLoaders['insights/audit'] = loadAudit;
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

let historyPlayers = [];
const dur = (ms) => fmt.duration(Math.round(ms / 1000));

function sessionList(p) {
  return el('ol', { class: 'sessions' }, ...[...p.recent].reverse().map((s) => el('li', {},
    el('span', {}, fmt.date(s.start)),
    el('span', { class: 'note' }, s.end ? `${dur(s.end - s.start)}` : 'online now'))));
}

function historyRow(p) {
  const detail = el('tr', { class: 'detail', hidden: true }, el('td', { colspan: 6 },
    el('div', { class: 'player-detail' },
      el('div', {}, el('h3', {}, 'Recent sessions'), sessionList(p)),
      el('div', { class: 'stack' },
        el('dl', { class: 'facts' },
          p.uuid ? el('div', {}, el('dt', {}, 'UUID'), el('dd', { class: 'mono' }, p.uuid)) : null,
          p.ip ? el('div', {}, el('dt', {}, 'Last IP'), el('dd', { class: 'mono' }, p.ip)) : null),
        el('div', { class: 'row wrap' },
          rowActionBtn('Whitelist', 'add', `whitelist add ${p.name}`),
          rowActionBtn('Make op', 'op', `op ${p.name}`, CONFIRM_ADD.op(p.name)),
          p.online ? rowActionBtn('Kick', 'remove', `kick ${p.name}`, { title: `Kick ${p.name}?`, confirm: 'Kick', tone: 'danger', icon: 'remove' }) : null,
          rowActionBtn('Ban', 'ban', `ban ${p.name}`, CONFIRM_ADD.ban(p.name), true),
          el('button', { class: 'btn btn-quiet btn-sm', onclick: () => searchPlayerLogs(p.name) }, icon('search'), 'Search logs'))))));
  const toggle = el('button', { class: 'btn btn-quiet btn-sm', 'aria-expanded': 'false' }, icon('history'), 'Details');
  toggle.addEventListener('click', () => {
    detail.hidden = !detail.hidden;
    toggle.setAttribute('aria-expanded', !detail.hidden);
  });
  const row = el('tr', { 'data-name': p.name.toLowerCase() },
    el('td', { class: 'primary-cell', 'data-label': 'Player' }, el('div', { class: 'plugin' }, avatar(p.uuid || p.name),
      el('div', {}, p.name, p.online ? el('span', { class: 'pill own' }, 'Online') : null))),
    el('td', { 'data-label': 'Last seen' }, p.online ? 'Now' : [fmt.relative(new Date(p.last).toISOString()), el('span', { class: 'sub' }, fmt.date(new Date(p.last).toISOString()))]),
    el('td', { 'data-label': 'First seen' }, fmt.date(new Date(p.first).toISOString())),
    el('td', { class: 'num', 'data-label': 'Sessions' }, String(p.sessions)),
    el('td', { class: 'num', 'data-label': 'Playtime' }, dur(p.playtime)),
    el('td', { class: 'act' }, toggle));
  return [row, detail];
}

function rowActionBtn(label, iconName, command, confirmOpts, danger) {
  const btn = el('button', { class: `btn btn-quiet btn-sm${danger ? ' danger' : ''}` }, icon(iconName), label);
  btn.addEventListener('click', async () => {
    if (confirmOpts && !(await confirmAction(confirmOpts))) return;
    busy(btn, () => mutate(command));
  });
  return btn;
}

function renderHistoryRows() {
  const q = $('ph-filter').value.trim().toLowerCase();
  const shown = historyPlayers.filter((p) => !q || p.name.toLowerCase().includes(q));
  $('ph-list').replaceChildren(...(shown.length
    ? shown.flatMap(historyRow)
    : [emptyRow(6, historyPlayers.length ? `Nobody called “${q}” has played here.` : 'No player activity in the logs yet.')]));
}

async function loadPlayerHistory() {
  if (!historyPlayers.length) skeletonRows($('ph-list'), 6);
  try {
    const h = await api('GET', '/api/players/history');
    historyPlayers = h.players;
    const now = Date.now();
    const week = h.players.filter((p) => now - p.last < 7 * 86400000).length;
    const total30 = h.daily.reduce((n, d) => n + d.playtime, 0);
    statList('ph-kpis', [
      ['Players seen', String(h.players.length)],
      ['Online now', String(h.players.filter((p) => p.online).length)],
      ['Active this week', String(week)],
      ['Played, 30 days', dur(total30)],
    ]);
    $('ph-info').textContent = `From ${h.files} log file${h.files === 1 ? '' : 's'}. Old logs are remembered even after they are deleted.`;
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now - i * 86400000);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const found = h.daily.find((x) => x.day === key);
      days.push({ value: (found?.playtime || 0) / 3600000, players: found?.players || 0, label: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }), title: d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) });
    }
    barChart($('ph-daily'), days, { label: 'Hours played per day', fmt: (v) => `${+v.toFixed(1)}h`, detail: (b) => [`${b.value.toFixed(1)} hours played`, `${b.players} player${b.players === 1 ? '' : 's'}`] });
    renderHistoryRows();
  } catch (e) {
    $('ph-list').replaceChildren(emptyRow(6, `Can't read player history: ${e.message}`));
  }
}
viewLoaders['players/history'] = loadPlayerHistory;
$('ph-filter').addEventListener('input', renderHistoryRows);

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
    if (!a) return [];
    return subs.length
      ? subs.map((t) => ({ group: 'Go to', icon: a.icon, label: `${a.name} → ${t.textContent.trim()}`, keys: `${area} ${t.dataset.view}`, run: () => showTab(`${area}/${t.dataset.view}`) }))
      : [{ group: 'Go to', icon: a.icon, label: a.name, keys: area, run: () => showTab(area) }];
  });
  items.push(...views);
  const act = (label, iconName, keys, run, when = () => true) => when() && items.push({ group: 'Actions', icon: iconName, label, keys, run });
  const p = lastStatus?.power || {};
  act('Restart the server…', 'restart', 'reboot restart power', () => { showTab('server/overview'); power('restart'); }, () => p.available && p.active === 'active');
  act('Stop the server…', 'stop', 'shutdown stop power off', () => { showTab('server/overview'); power('stop'); }, () => p.available && p.active === 'active');
  act('Start the server', 'play', 'start power on boot', () => { showTab('server/overview'); power('start'); }, () => p.available && p.active !== 'active');
  act(lastStatus?.maintenance?.enabled ? 'Turn off maintenance mode' : 'Turn on maintenance mode…', 'maintenance', 'maintenance lock whitelist', () => { showTab('server/overview'); $('maint-toggle').click(); });
  act('Back up the active world', 'backups', 'backup save snapshot', () => { showTab('worlds'); $('backup-now').click(); });
  act('Create a new world…', 'worlds', 'new world create generate', () => { showTab('worlds'); toggleWorldForm(true); });
  act('Check for Paper updates', 'updates', 'paper update upgrade version', () => { showTab('server/updates'); loadUpdates(true); });
  act('Check for rconsole updates', 'updates', 'rconsole self update version upgrade', () => { showTab('server/updates'); loadSelfUpdate(true); });
  act('Check for plugin updates', 'plugins', 'plugin modrinth update', () => { showTab('server/plugins'); loadPlugins(true); });
  act('Find a plugin on Modrinth…', 'plugins', 'install plugin modrinth search add', () => { showTab('server/plugins'); $('plugin-search').elements.q.focus(); });
  act('Search the logs…', 'search', 'logs grep find error', () => { showTab('insights/logs'); $('ls-form').elements.q.focus(); });
  act('Add a scheduled task…', 'schedule', 'cron schedule task timer', () => { showTab('schedule'); });
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
  try {
    const n = await api('GET', '/api/notify');
    const f = notifyForm.elements;
    f.url.value = n.url;
    f.url.disabled = n.fromEnv;
    f.token.value = '';
    f.token.placeholder = n.hasToken ? 'Saved; leave empty to keep' : 'tk_… (only for protected topics)';
    f.token.disabled = n.fromEnv;
    f.tpsBelow.value = n.tpsBelow;
    f.tpsMinutes.value = n.tpsMinutes;
    $('notify-events').replaceChildren(...n.events.map((e) => el('label', { class: 'check' }, el('input', { type: 'checkbox', name: `ev-${e.key}`, checked: e.enabled || undefined }), el('span', {}, e.label))));
    $('notify-note').textContent = n.fromEnv ? 'Topic and token come from NTFY_URL / NTFY_TOKEN in rconsole.env.' : n.url ? 'Notifications are on.' : 'Off until a topic URL is set. Pick a long, unguessable topic name: anyone who knows it can read the alerts.';
    $('ntfy-test').disabled = !n.url;
  } catch (e) {
    $('notify-note').textContent = e.message;
  }
}
viewLoaders['server/overview'] = loadNotify;

notifyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = notifyForm.elements;
  const body = {
    events: Object.fromEntries([...notifyForm.querySelectorAll('[name^=ev-]')].map((c) => [c.name.slice(3), c.checked])),
    tpsBelow: Number(f.tpsBelow.value),
    tpsMinutes: Number(f.tpsMinutes.value),
  };
  if (!f.url.disabled) body.url = f.url.value.trim();
  if (!f.token.disabled && f.token.value) body.token = f.token.value;
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
tabLoaders.map = async () => {
  if (mapChecked && $('map-iframe').src) return;
  try {
    const { configured, src } = await api('GET', '/api/map');
    mapChecked = true;
    $('map-frame').hidden = !configured;
    $('map-setup').hidden = configured;
    if (configured) {
      $('map-iframe').src = src;
      $('map-open').href = src;
    }
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
  $('more-list').replaceChildren(...Object.entries(AREAS).slice(PHONE_TABS).map(([key, a]) =>
    el('button', { class: `more-item${key === current ? ' on' : ''}`, 'data-tab': key, onclick: () => { moreSheet.close(); showTab(key); } },
      el('span', { class: 'tile' }, icon(a.icon)), a.name)),
    el('button', { class: 'more-item', onclick: () => { moreSheet.close(); openPalette(); } }, el('span', { class: 'tile' }, icon('search')), 'Search & run'),
    el('button', { class: 'more-item', onclick: signOut }, el('span', { class: 'tile' }, icon('signout')), 'Sign out'));
  $('nav-more').setAttribute('aria-expanded', 'true');
  moreSheet.showModal();
});
moreSheet.addEventListener('close', () => $('nav-more').setAttribute('aria-expanded', 'false'));
moreSheet.addEventListener('click', (e) => { if (e.target === moreSheet) moreSheet.close(); });

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

'use strict';

// Problems: crashes, out-of-memory, a hanging server, plugins that fail and
// other errors, found in the server log. Recent logs are scanned on request
// (like log search) and grouped by kind, plugin and message; new lines are
// classified live for alerts. Crashes that leave no trace in the log (the
// process killed, systemd reporting a failure) are kept in problems.json,
// together with what the admin has already seen.

const fs = require('fs');
const path = require('path');
const { listFiles, scanFile, parseLine } = require('./logfiles');

const DAY = 24 * 3600 * 1000;
const CACHE_MS = 60 * 1000;
const BUDGET_MS = 8000;
const MAX_GROUPS = 300;
const SEVERITY = { critical: 3, error: 2, warning: 1 };

// First match wins. `plugin` pulls the plugin name out of the message.
const RULES = [
  { kind: 'crash', severity: 'critical', title: 'Server crashed', re: /crash report has been saved|Encountered an unexpected exception|Exception in server tick loop|Failed to start the minecraft server/i },
  { kind: 'oom', severity: 'critical', title: 'Out of memory', re: /OutOfMemoryError/ },
  { kind: 'hang', severity: 'critical', title: 'Server stopped responding', re: /has stopped responding|A single server tick took/i },
  { kind: 'plugin', severity: 'error', title: 'Plugin failed to load or enable', re: /Error occurred while (?:enabling|disabling|loading)|Could not load '[^']+' in folder|Could not load plugin|Failed to load mod|Mod .* has failed to load/i },
  { kind: 'plugin', severity: 'error', title: 'Plugin error', re: /Could not pass event|Encountered an exception while|Unhandled exception occurred in|Task #\d+ for .* generated an exception/i },
  { kind: 'lag', severity: 'warning', title: "Server can't keep up", re: /Can't keep up! Is the server overloaded\?/ },
  { kind: 'plugin', severity: 'warning', title: 'Plugin needs Vault', re: /without Vault installed|Vault (?:is )?not (?:found|installed)|requires? Vault\b|Vault dependency/i, hint: 'Vault is not on Modrinth. Its maintained successor VaultUnlocked is: Server → Plugins, search "vault".' },
];

// Lines that look like errors but aren't problems. Paper refuses a command
// that arrives over RCON while the server is already stopping; that is
// rconsole's own status probe racing the shutdown.
const IGNORE = [/failed main thread check: Cannot perform command async/];

function pluginOf(msg) {
  let m = msg.match(/while (?:enabling|disabling|loading) (\S+?)(?: v[\d.][^\s]*)?(?: \(|$|\s)/i);
  if (m) return m[1];
  m = msg.match(/Could not load '(?:[^'/]*\/)?([^'/]+?)(?:\.jar)?' in folder/i);
  if (m) return m[1];
  m = msg.match(/ (?:to|for) ([A-Za-z0-9_.-]+) v\d/);
  if (m) return m[1];
  m = msg.match(/^\[([A-Za-z0-9_.-]{2,40})\] /);
  if (m && !/^(?:STDOUT|STDERR|Server|minecraft|Not Secure)$/i.test(m[1])) return m[1];
  return null;
}

// Messages that differ only in numbers, UUIDs, coordinates or names in
// quotes belong to the same group.
const signature = (msg) => msg
  .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
  .replace(/'[^']{1,60}'/g, "'…'")
  .replace(/-?\d+(?:\.\d+)?/g, '#')
  .slice(0, 160);

// Returns { kind, severity, title, plugin, behindMs } or null.
function classify(p) {
  if (!p) return null;
  const msg = p.msg || '';
  if (IGNORE.some((re) => re.test(msg))) return null;
  for (const r of RULES) {
    if (!r.re.test(msg)) continue;
    const out = { kind: r.kind, severity: r.severity, title: r.title, plugin: r.kind === 'plugin' || r.kind === 'oom' ? pluginOf(msg) : null };
    if (r.hint) out.hint = r.hint;
    if (r.kind === 'lag') out.behindMs = Number(msg.match(/Running (\d+)ms/)?.[1]) || null;
    return out;
  }
  if (p.level === 'ERROR' || p.level === 'FATAL') return { kind: 'error', severity: 'error', title: 'Error', plugin: pluginOf(msg) };
  return null;
}

const keyOf = (c, msg) => (c.kind === 'lag' ? 'lag' : `${c.kind}|${c.plugin || ''}|${signature(msg)}`);

// Adds one occurrence to `groups` (a Map), returns [group, isNew].
function add(groups, c, msg, t) {
  const key = keyOf(c, msg);
  let g = groups.get(key);
  const isNew = !g;
  if (!g) {
    g = { key, kind: c.kind, severity: c.severity, title: c.title, plugin: c.plugin, message: c.kind === 'lag' ? null : msg.slice(0, 500), detail: null, hint: c.hint || null, count: 0, first: t, last: t, maxBehindMs: null };
    groups.set(key, g);
  }
  g.count++;
  g.first = Math.min(g.first, t);
  g.last = Math.max(g.last, t);
  if (c.behindMs) g.maxBehindMs = Math.max(g.maxBehindMs || 0, c.behindMs);
  return [g, isNew];
}

// The exception line of a stack trace: "java.lang.NullPointerException: …"
// or "Caused by: …", the most telling part of a multi-line error.
const EXCEPTION_RE = /^(?:Caused by: )?(?:[a-z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable)\b.*/;

class Problems {
  // checks: conditions of the machine that hold right now (lib/hostcheck.js).
  constructor({ mcDir, stateDir, log = () => {}, onProblem = () => {}, checks = () => [] }) {
    Object.assign(this, { mcDir, log, onProblem, checks });
    this.file = path.join(stateDir, 'problems.json');
    this.state = { seenAt: 0, events: [], muted: [] }; // events: problems the log can't show (systemd failures); muted: group keys
    try {
      Object.assign(this.state, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {}
    this.cache = new Map();
    this.ready = false; // live lines count only after the tail's initial replay
    this.live = new Map(); // key -> group, for today's alerts
    this.liveDay = null;
    this.lastLive = null; // the group a following stack trace belongs to
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // Groups from the last `days` of logs, plus recorded events.
  async scan({ days = 7 } = {}) {
    days = [1, 7].includes(Number(days)) ? Number(days) : 7;
    const hit = this.cache.get(days);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const since = Date.now() - days * DAY;
    const groups = new Map();
    const deadline = Date.now() + BUDGET_MS;
    let timedOut = false;
    const files = (await listFiles(path.join(this.mcDir, 'logs'))).reverse();
    for (const f of files) {
      if (!f.latest && f.date && new Date(`${f.date}T23:59:59`).getTime() < since) break;
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      let current = null;
      const r = await scanFile(f, (p) => {
        const c = classify(p);
        current = c ? { c, msg: p.msg, detail: null } : null;
        return current || undefined;
      }, {
        stop: () => Date.now() > deadline,
        more: (raw) => {
          if (current && !current.detail) current.detail = raw.trim().match(EXCEPTION_RE)?.[0] || null;
        },
      });
      if (r.stopped) timedOut = true;
      for (const item of r.items) {
        if (item.t < since) continue;
        const [g] = add(groups, item.c, item.msg, item.t);
        if (item.detail && !g.detail) g.detail = item.detail.slice(0, 300);
      }
    }
    for (const e of this.state.events) {
      if (e.t < since) continue;
      const [g] = add(groups, { kind: e.kind, severity: e.severity, title: e.title, plugin: null }, e.message, e.t);
      g.detail = g.detail || e.detail || null;
    }
    let current = [];
    try {
      current = this.checks();
    } catch (err) {
      this.log(`problems: host checks: ${err.message}`);
    }
    for (const c of current) {
      const [g] = add(groups, { kind: c.kind, severity: c.severity, title: c.title, plugin: null, hint: c.hint }, c.message, Date.now());
      g.current = true; // holds right now: can't be marked as seen away
    }
    const muted = new Set(this.state.muted || []);
    const all = [...groups.values()];
    const list = all
      .filter((g) => !muted.has(g.key))
      .sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity] || b.last - a.last)
      .slice(0, MAX_GROUPS)
      .map((g) => ({ ...g, unseen: g.last > this.state.seenAt }));
    const value = { days, groups: list, muted: all.length - list.length, seenAt: this.state.seenAt, timedOut };
    this.cache.set(days, { at: Date.now(), value });
    return value;
  }

  // For /api/status: unseen errors and worse from the last 24 hours.
  async summary() {
    const { groups } = await this.scan({ days: 1 });
    const unseen = groups.filter((g) => g.unseen && g.severity !== 'warning');
    return { unseen: unseen.length, critical: unseen.filter((g) => g.severity === 'critical').length };
  }

  markSeen() {
    this.state.seenAt = Date.now();
    this.save();
    this.cache.clear();
    return { seenAt: this.state.seenAt };
  }

  // Hides a kind of problem (its group key) from the list, the bell and
  // alerts until unmuted; for known, harmless messages.
  mute(key, on = true) {
    key = String(key || '').slice(0, 300);
    if (!key) throw Object.assign(new Error('Missing problem key'), { status: 400 });
    const set = new Set(this.state.muted || []);
    if (on) set.add(key);
    else set.delete(key);
    this.state.muted = [...set].slice(-200);
    this.save();
    this.cache.clear();
    return { muted: this.state.muted.length };
  }

  unmuteAll() {
    this.state.muted = [];
    this.save();
    this.cache.clear();
    return { muted: 0 };
  }

  isMuted(key) {
    return (this.state.muted || []).includes(key);
  }

  // A failure only systemd knows about, e.g. the process was killed.
  record({ kind = 'crash', severity = 'critical', title, message, detail = null }) {
    const e = { kind, severity, title, message, detail, t: Date.now() };
    this.state.events = [...this.state.events.filter((x) => Date.now() - x.t < 30 * DAY), e].slice(-100);
    this.save();
    this.cache.clear();
    this.onProblem({ ...e, plugin: null, count: 1, first: e.t, last: e.t, isNew: true });
  }

  onLogLine(line) {
    if (!this.ready) return;
    const p = parseLine(line);
    if (!p) {
      const g = this.lastLive;
      const ex = line.trim().match(EXCEPTION_RE)?.[0];
      if (g && ex && !g.detail) {
        g.detail = ex.slice(0, 300);
        if (g.pendingDetail) {
          g.pendingDetail = false;
          this.onProblem({ ...g, isNew: true });
        }
      }
      return;
    }
    const c = classify(p);
    this.lastLive = null;
    if (!c) return;
    this.cache.clear();
    const day = new Date().toDateString();
    if (day !== this.liveDay) {
      this.live = new Map();
      this.liveDay = day;
    }
    const [g, isNew] = add(this.live, c, p.msg, Date.now());
    this.lastLive = g;
    if (!isNew || c.kind === 'lag' || this.isMuted(g.key)) return; // lag has its own TPS alert
    // Wait a moment for the stack trace's exception line, then alert.
    g.pendingDetail = true;
    setTimeout(() => {
      if (!g.pendingDetail) return;
      g.pendingDetail = false;
      this.onProblem({ ...g, isNew: true });
    }, 1500).unref?.();
  }
}

module.exports = { Problems, classify, pluginOf, signature };

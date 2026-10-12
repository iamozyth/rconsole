'use strict';

// Player history from the server logs: who joined when, for how long, from
// where. Rotated .log.gz files never change, so their events are cached in
// STATE_DIR/players.json and survive the logs being cleaned up. latest.log is
// rescanned when it has grown.

const fs = require('fs');
const path = require('path');
const { listFiles, scanFile } = require('./logfiles');

const NAME = '(\\.?[A-Za-z0-9_]{1,16})';
// Paper 26 logs system messages as "System chat: Steve joined the game".
const SYS = '(?:System chat: )?';
const PATTERNS = [
  [new RegExp(`^UUID of player ${NAME} is ([0-9a-f-]{32,36})`, 'i'), (m) => ['uuid', m[1], m[2]]],
  [new RegExp(`^${NAME}\\[/?([^\\]]+)\\] logged in with entity id`), (m) => ['ip', m[1], m[2].replace(/:\d+$/, '')]],
  [new RegExp(`^${SYS}${NAME} joined the game`), (m) => ['join', m[1]]],
  [new RegExp(`^${SYS}${NAME} left the game`), (m) => ['leave', m[1]]],
  [new RegExp(`^${NAME} lost connection:`), (m) => ['leave', m[1]]],
  [/^Starting minecraft server version/, () => ['start']],
  [/^Stopping (?:the )?server/, () => ['stop']],
];
const RESCAN_MS = 30 * 1000;
const RECENT = 15;
const DAYS = 30;

function pickEvent(p) {
  if (p.level !== 'INFO') return undefined;
  for (const [re, make] of PATTERNS) {
    const m = p.msg.match(re);
    if (m) {
      const [type, name, extra] = make(m);
      return { type, name, extra };
    }
  }
  return undefined;
}

const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Turns ordered per-file event lists into per-player summaries.
function summarize(files, now = Date.now()) {
  const players = new Map();
  const daily = new Map();
  const get = (name) => {
    const key = name.toLowerCase();
    if (!players.has(key)) players.set(key, { name, uuid: null, ip: null, first: null, last: null, playtime: 0, sessions: 0, recent: [], online: false });
    const p = players.get(key);
    p.name = name;
    return p;
  };
  const addDaily = (start, end, name) => {
    // Split sessions at midnight so each day gets its share.
    let s = start;
    while (s < end) {
      const d = new Date(s);
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      const e = Math.min(end, next);
      const k = dayKey(s);
      if (!daily.has(k)) daily.set(k, { day: k, playtime: 0, players: new Set() });
      daily.get(k).playtime += e - s;
      daily.get(k).players.add(name.toLowerCase());
      s = e;
    }
  };
  const close = (open, name, end) => {
    const start = open.get(name.toLowerCase());
    if (start == null) return;
    open.delete(name.toLowerCase());
    const p = get(name);
    const dur = Math.max(0, end - start);
    p.playtime += dur;
    p.last = Math.max(p.last || 0, end);
    p.recent.push({ start, end });
    if (p.recent.length > RECENT) p.recent.shift();
    addDaily(start, end, name);
  };
  for (const f of files) {
    const open = new Map();
    const names = new Map();
    const closeAll = (t) => {
      for (const key of [...open.keys()]) close(open, names.get(key), t);
    };
    for (const e of f.events) {
      if (e.type === 'start' || e.type === 'stop') {
        closeAll(e.t);
        continue;
      }
      const p = get(e.name);
      if (e.type === 'uuid') p.uuid = e.extra;
      else if (e.type === 'ip') p.ip = e.extra;
      else if (e.type === 'join') {
        close(open, e.name, e.t);
        open.set(e.name.toLowerCase(), e.t);
        names.set(e.name.toLowerCase(), e.name);
        p.first = p.first == null ? e.t : Math.min(p.first, e.t);
        p.last = Math.max(p.last || 0, e.t);
        p.sessions++;
      } else if (e.type === 'leave') close(open, e.name, e.t);
    }
    if (f.latest) {
      // Still connected: count the session up to now.
      for (const [key, start] of open) {
        const p = get(names.get(key));
        p.online = true;
        p.playtime += now - start;
        p.last = now;
        p.recent.push({ start, end: null });
        if (p.recent.length > RECENT) p.recent.shift();
        addDaily(start, now, p.name);
      }
    } else closeAll(f.last ?? (f.events.length ? f.events[f.events.length - 1].t : 0));
  }
  const since = dayKey(now - (DAYS - 1) * 86400000);
  return {
    players: [...players.values()].filter((p) => p.sessions > 0).sort((a, b) => b.last - a.last),
    daily: [...daily.values()].filter((d) => d.day >= since).sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ day: d.day, playtime: d.playtime, players: d.players.size })),
  };
}

class PlayerHistory {
  constructor({ mcDir, stateDir, log = () => {} }) {
    this.logsDir = path.join(mcDir, 'logs');
    this.file = path.join(stateDir, 'players.json');
    this.log = log;
    this.cache = this.load();
    this.latest = null; // { size, mtime, events, last, at }
    this.building = null;
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version === 2) return data; // 2: "System chat:" joins (Paper 26)
    } catch {}
    return { version: 2, files: {} };
  }

  async persist() {
    try {
      await fs.promises.writeFile(`${this.file}.tmp`, JSON.stringify(this.cache), { mode: 0o600 });
      await fs.promises.rename(`${this.file}.tmp`, this.file);
    } catch (err) {
      this.log(`players: can't save history: ${err.message}`);
    }
  }

  async scan(file) {
    const r = await scanFile(file, pickEvent);
    return { events: r.items.map(({ t, type, name, extra }) => ({ t, type, ...(name ? { name } : {}), ...(extra ? { extra } : {}) })), last: r.last };
  }

  async refresh() {
    const files = await listFiles(this.logsDir);
    let changed = false;
    for (const f of files.filter((x) => !x.latest)) {
      const cached = this.cache.files[f.name];
      if (cached && cached.size === f.size) continue;
      try {
        this.cache.files[f.name] = { size: f.size, date: f.date, index: f.index, ...(await this.scan(f)) };
        changed = true;
      } catch (err) {
        this.log(`players: can't read ${f.name}: ${err.message}`);
      }
    }
    if (changed) await this.persist();
    const latest = files.find((x) => x.latest);
    if (latest && (!this.latest || this.latest.size !== latest.size || this.latest.mtime !== latest.mtime)) {
      try {
        this.latest = { size: latest.size, mtime: latest.mtime, ...(await this.scan(latest)) };
      } catch (err) {
        this.log(`players: can't read latest.log: ${err.message}`);
      }
    }
    this.refreshedAt = Date.now();
  }

  async history() {
    if (!this.refreshedAt || Date.now() - this.refreshedAt > RESCAN_MS) {
      this.building ??= this.refresh().finally(() => (this.building = null));
      await this.building;
    }
    const rotated = Object.values(this.cache.files).sort((a, b) => a.date.localeCompare(b.date) || a.index - b.index);
    const files = [...rotated, ...(this.latest ? [{ ...this.latest, latest: true }] : [])];
    return { ...summarize(files), files: files.length };
  }
}

module.exports = { PlayerHistory, summarize, pickEvent };

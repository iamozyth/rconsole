'use strict';

// Push notifications through ntfy (https://ntfy.sh or self-hosted). The topic
// URL and token come from NTFY_URL / NTFY_TOKEN, or are set in the UI and kept
// in STATE_DIR/notify.json. Each event type can be switched on or off; repeats
// are rate-limited so a flapping server doesn't flood the phone.

const fs = require('fs');
const path = require('path');
const { parseLine } = require('./logfiles');
const { pickEvent } = require('./players');

const EVENTS = {
  down: { label: 'Server went down or came back', default: true, priority: 5, tags: 'rotating_light' },
  tps: { label: 'TPS stayed low', default: true, priority: 4, tags: 'snail' },
  backup: { label: 'Backup failed', default: true, priority: 4, tags: 'floppy_disk' },
  backupOk: { label: 'Backup finished', default: false, priority: 2, tags: 'floppy_disk' },
  ops: { label: 'Scheduled task or operation failed', default: true, priority: 4, tags: 'warning' },
  disk: { label: 'Disk almost full', default: true, priority: 4, tags: 'card_file_box' },
  updates: { label: 'Updates available (server, plugins or mods, rconsole), daily', default: true, priority: 2, tags: 'package' },
  security: { label: 'Sign-in locked out after failed attempts', default: true, priority: 4, tags: 'lock' },
  players: { label: 'Player joined or left', default: false, priority: 3, tags: 'bust_in_silhouette' },
};
const MIN_GAP_MS = 10 * 60 * 1000; // per event key
const HOURLY_CAP = 30;

class Notify {
  constructor({ stateDir, log = () => {}, publicUrl = '' }) {
    this.file = path.join(stateDir, 'notify.json');
    this.log = log;
    this.publicUrl = publicUrl;
    this.config = this.load();
    this.last = new Map(); // key -> time sent
    this.sentTimes = [];
    this.lowTps = 0;
    this.tpsAlerted = false;
    this.wasUp = null;
    this.diskAlerted = false;
    this.backupSeen = null;
    this.online = null; // player names at the last sample
  }

  load() {
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {}
    const events = Object.fromEntries(Object.entries(EVENTS).map(([k, e]) => [k, saved.events?.[k] ?? e.default]));
    return {
      url: process.env.NTFY_URL || saved.url || '',
      token: process.env.NTFY_TOKEN || saved.token || '',
      fromEnv: Boolean(process.env.NTFY_URL),
      events,
      tpsBelow: saved.tpsBelow ?? 15,
      tpsMinutes: saved.tpsMinutes ?? 3,
      diskBelow: saved.diskBelow ?? 0.1,
      seen: saved.seen || {}, // update keys already announced
    };
  }

  save() {
    const { url, token, fromEnv, ...rest } = this.config;
    const out = { ...rest, ...(fromEnv ? {} : { url, token }) };
    fs.writeFileSync(this.file, JSON.stringify(out, null, 2), { mode: 0o600 });
  }

  // What the UI sees: never the token itself.
  view() {
    const { token, seen, ...rest } = this.config;
    return { ...rest, hasToken: Boolean(token), events: Object.entries(EVENTS).map(([key, e]) => ({ key, label: e.label, enabled: this.config.events[key] })) };
  }

  update(input) {
    const c = this.config;
    if (!c.fromEnv && input.url !== undefined) {
      const url = String(input.url).trim();
      if (url && !/^https?:\/\/[^\s/]+\/[A-Za-z0-9_-]{1,64}$/.test(url)) throw Object.assign(new Error('Use the full topic URL, e.g. https://ntfy.sh/my-minecraft-alerts'), { status: 400 });
      c.url = url;
    }
    if (!c.fromEnv && input.token !== undefined) c.token = String(input.token).trim().slice(0, 200);
    if (input.events) for (const k of Object.keys(EVENTS)) if (typeof input.events[k] === 'boolean') c.events[k] = input.events[k];
    const num = (v, min, max, name) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) throw Object.assign(new Error(`${name} must be between ${min} and ${max}`), { status: 400 });
      return n;
    };
    if (input.tpsBelow !== undefined) c.tpsBelow = num(input.tpsBelow, 1, 20, 'TPS threshold');
    if (input.tpsMinutes !== undefined) c.tpsMinutes = num(input.tpsMinutes, 1, 60, 'Minutes');
    this.save();
    return this.view();
  }

  async send(event, title, message, { key = event, force = false } = {}) {
    const c = this.config;
    if (!c.url || (!force && !c.events[event])) return false;
    const now = Date.now();
    if (!force) {
      if (event !== 'players' && now - (this.last.get(key) || 0) < MIN_GAP_MS) return false;
      this.sentTimes = this.sentTimes.filter((t) => now - t < 3600e3);
      if (this.sentTimes.length >= HOURLY_CAP) return false;
    }
    this.last.set(key, now);
    this.sentTimes.push(now);
    const e = EVENTS[event] || { priority: 3, tags: 'bell' };
    try {
      const res = await fetch(c.url, {
        method: 'POST',
        body: message,
        headers: {
          Title: title,
          Priority: String(e.priority),
          Tags: e.tags,
          ...(this.publicUrl ? { Click: this.publicUrl } : {}),
          ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}),
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
      this.log(`notify: sent "${title}"`);
      return true;
    } catch (err) {
      this.log(`notify: ${err.message}`);
      if (force) throw err;
      return false;
    }
  }

  // --- event sources --------------------------------------------------------

  // Every metrics sample (30 s): up/down, TPS, disk, backups.
  onSample(sample, { stats, ops, countdown, backups }) {
    this.onPlayers(stats?.cache?.game?.players?.players);
    const planned = ops?.state?.running || countdown?.remaining != null;
    const up = sample.up === 1;
    if (this.wasUp !== null && up !== this.wasUp) {
      if (!up) this.send('down', planned ? 'Minecraft server stopped' : 'Minecraft server is down', planned ? `Stopped during: ${ops?.state?.label || 'a scheduled restart'}` : 'The server stopped responding or its service is not running.', { key: 'down' });
      else this.send('down', 'Minecraft server is back up', 'The server is running again.', { key: 'up' });
    }
    this.wasUp = up;

    const c = this.config;
    if (up && sample.tps != null && sample.tps < c.tpsBelow) this.lowTps++;
    else {
      if (this.tpsAlerted && sample.tps != null) this.send('tps', 'TPS recovered', `TPS is back at ${sample.tps.toFixed(1)}.`, { key: 'tps-ok' });
      this.lowTps = 0;
      this.tpsAlerted = false;
    }
    if (!this.tpsAlerted && this.lowTps * 30 >= c.tpsMinutes * 60) {
      this.tpsAlerted = true;
      this.send('tps', 'Server is lagging', `TPS has been below ${c.tpsBelow} for ${c.tpsMinutes} minutes (now ${sample.tps.toFixed(1)}, ${sample.players ?? 0} players online).`, { key: 'tps' });
    }

    const disk = stats?.cache?.host?.disk;
    if (disk?.total) {
      const free = disk.available / disk.total;
      if (free < c.diskBelow && !this.diskAlerted) {
        this.diskAlerted = true;
        this.send('disk', 'Disk almost full', `Only ${Math.round(free * 100)}% (${(disk.available / 2 ** 30).toFixed(1)} GB) free on the server disk. Backups and the world may fail to save.`);
      } else if (free > c.diskBelow * 1.5) this.diskAlerted = false;
    }

    const b = backups?.state;
    if (b?.lastFinishedAt && b.lastFinishedAt !== this.backupSeen) {
      if (this.backupSeen !== null) {
        if (b.lastError) this.send('backup', 'Backup failed', b.lastError, { key: `backup-${b.lastFinishedAt}` });
        else this.send('backupOk', 'Backup finished', b.lastFile || 'Backup created', { key: `backupok-${b.lastFinishedAt}` });
      }
      this.backupSeen = b.lastFinishedAt;
    } else if (this.backupSeen === null) this.backupSeen = b?.lastFinishedAt || '';
  }

  // Joins and leaves come from two sources sharing one view of who is
  // online: the server log (immediate, catches short visits) and the player
  // list polled every 30 s (catches servers whose plugins change the join
  // message). Whichever sees a change first reports it; the other agrees.
  playerEvent(name, joined) {
    if (!this.online) return; // no baseline yet
    if (joined === this.online.has(name)) return;
    if (joined) this.online.add(name);
    else this.online.delete(name);
    if (!this.config.events.players || !this.config.url) return;
    const n = this.online.size;
    this.send('players', `${name} ${joined ? 'joined' : 'left'}`, `${name} ${joined ? 'joined' : 'left'} the server (${n} online).`, { key: `p-${name}-${joined ? 'in' : 'out'}` });
  }

  onLogLine(line) {
    const p = parseLine(line);
    const e = p && pickEvent(p);
    if (e?.type === 'join' || e?.type === 'leave') this.playerEvent(e.name, e.type === 'join');
  }

  onPlayers(list) {
    if (!Array.isArray(list)) {
      this.online = null; // RCON down: start over instead of reporting everyone
      return;
    }
    if (!this.online) {
      this.online = new Set(list);
      return;
    }
    for (const name of list) this.playerEvent(name, true);
    for (const name of [...this.online]) if (!list.includes(name)) this.playerEvent(name, false);
  }

  onAudit(e) {
    if (e.ok) return;
    if (e.action === 'login' && e.error === 'locked out') this.send('security', 'Sign-in locked out', `Too many failed sign-ins for "${e.user}" from ${e.ip}.`, { key: `lock-${e.ip}` });
    else if (e.user === 'schedule' || e.action === 'operation') this.send('ops', `${e.user === 'schedule' ? 'Scheduled task' : 'Operation'} failed: ${e.target}`, e.error || 'Failed', { key: `ops-${e.target}` });
  }

  // Announces each new version once.
  async checkUpdates({ updates, plugins, selfUpdate }) {
    if (!this.config.url || !this.config.events.updates) return;
    const found = [];
    try {
      const o = await updates.overview();
      if (o.newerBuilds?.[0]) found.push([`${o.platform?.id || 'paper'}-${o.newerBuilds[0].id}`, `${o.platform?.name || 'Paper'} build ${o.newerBuilds[0].id}`]);
    } catch {}
    try {
      for (const p of (await plugins.list()).plugins) if (p.update) found.push([`plugin-${p.file}-${p.update.version}`, `${p.name} ${p.update.version}`]);
    } catch {}
    try {
      const s = await selfUpdate.overview();
      if (s.check?.status === 'ahead' && s.check.latest) found.push([`self-${s.check.latest.sha}`, `rconsole (${s.check.behind} new commit${s.check.behind === 1 ? '' : 's'})`]);
    } catch {}
    const fresh = found.filter(([k]) => !this.config.seen[k]);
    if (!fresh.length) return;
    const sent = await this.send('updates', 'Updates available', fresh.map(([, label]) => `• ${label}`).join('\n'), { key: `updates-${fresh.map(([k]) => k).join()}` });
    if (sent) {
      for (const [k] of fresh) this.config.seen[k] = new Date().toISOString();
      this.save();
    }
  }
}

module.exports = { Notify, EVENTS };

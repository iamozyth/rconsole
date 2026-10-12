'use strict';

// Push notifications through ntfy (https://ntfy.sh or self-hosted), published
// as JSON (https://docs.ntfy.sh/publish/#publish-as-json): plain-text bodies,
// emoji tags, a click target and buttons that open the right page in
// rconsole, and sequence IDs so a follow-up ("back up", "recovered", "left
// after 12 min") replaces the original notification instead of piling up.
//
// The topic URL and token come from NTFY_URL / NTFY_TOKEN, or from the UI
// (STATE_DIR/notify.json). Each event has its own on/off switch and
// priority; quiet hours deliver everything but outages silently. Optional
// one-tap actions (ban a scanner's address, start the server) use single-use
// tokens that expire after a day.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseLine } = require('./logfiles');
const { pickEvent } = require('./players');

// view: rconsole page the notification opens.
const EVENTS = {
  down: { label: 'Server went down or came back', default: true, priority: 5, tags: ['rotating_light'], view: 'server/overview' },
  tps: { label: 'Server is lagging (TPS stayed low)', default: true, priority: 4, tags: ['snail'], view: 'insights/metrics' },
  backup: { label: 'Backup failed', default: true, priority: 4, tags: ['floppy_disk', 'x'], view: 'worlds' },
  backupOk: { label: 'Backup finished', default: false, priority: 2, tags: ['floppy_disk'], view: 'worlds' },
  ops: { label: 'Scheduled task or operation failed', default: true, priority: 4, tags: ['warning'], view: 'insights/audit' },
  disk: { label: 'Disk almost full', default: true, priority: 4, tags: ['card_file_box'], view: 'server/overview' },
  updates: { label: 'Updates available (server, plugins or mods, rconsole), daily', default: true, priority: 2, tags: ['package'], view: 'server/updates' },
  security: { label: 'Sign-in locked out after failed attempts', default: true, priority: 4, tags: ['lock'], view: 'insights/audit' },
  scanner: { label: 'Unknown address tried to connect (scanners, strangers)', default: true, priority: 3, tags: ['satellite'], view: 'players/security' },
  players: { label: 'Player joined or left', default: false, priority: 3, tags: ['bust_in_silhouette'], view: 'players/history' },
};
const PRIORITIES = { 1: 'min', 2: 'low', 3: 'default', 4: 'high', 5: 'urgent' };
const MIN_GAP_MS = 10 * 60 * 1000; // per event key
const HOURLY_CAP = 30;
const TOKEN_TTL_MS = 24 * 3600 * 1000;
const MAX_BODY = 3800; // ntfy accepts 4096 bytes before turning it into an attachment
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;

const ago = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
};
// Plain text: the ntfy iOS app shows Markdown syntax literally.
const md = (s) => String(s);
const today = () => new Date().toISOString().slice(0, 10);

class Notify {
  constructor({ stateDir, log = () => {}, publicUrl = '' }) {
    this.file = path.join(stateDir, 'notify.json');
    this.log = log;
    this.envPublicUrl = publicUrl;
    this.config = this.load();
    this.last = new Map(); // key -> time sent
    this.sentTimes = [];
    this.tokens = new Map(); // one-tap action token -> { kind, arg, exp }
    this.handlers = {}; // kind -> async (arg) => result text; set by server.js
    this.lowTps = 0;
    this.tpsAlerted = false;
    this.wasUp = null;
    this.downSince = null;
    this.diskAlerted = false;
    this.backupSeen = null;
    this.online = null; // player names at the last sample
    this.joinedAt = new Map();
    this.listMissingSince = null;
    this.rebaselineMs = 5 * 60 * 1000;
    this.scanDay = { day: null, ips: new Map() };
  }

  load() {
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {}
    const events = Object.fromEntries(Object.entries(EVENTS).map(([k, e]) => [k, saved.events?.[k] ?? e.default]));
    const priorities = Object.fromEntries(Object.entries(EVENTS).map(([k, e]) => [k, saved.priorities?.[k] ?? e.priority]));
    return {
      url: process.env.NTFY_URL || saved.url || '',
      token: process.env.NTFY_TOKEN || saved.token || '',
      fromEnv: Boolean(process.env.NTFY_URL),
      publicUrl: saved.publicUrl || '',
      events,
      priorities,
      quiet: { enabled: false, from: '22:00', to: '07:00', ...(saved.quiet || {}) },
      oneTap: Boolean(saved.oneTap),
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

  get publicUrl() {
    return (this.envPublicUrl || this.config.publicUrl || '').replace(/\/+$/, '');
  }

  // What the UI sees: never the token itself.
  view() {
    const { token, seen, ...rest } = this.config;
    return {
      ...rest,
      publicUrl: this.publicUrl,
      publicUrlFromEnv: Boolean(this.envPublicUrl),
      hasToken: Boolean(token),
      priorityNames: PRIORITIES,
      events: Object.entries(EVENTS).map(([key, e]) => ({ key, label: e.label, enabled: this.config.events[key], priority: this.config.priorities[key] })),
    };
  }

  update(input) {
    const c = this.config;
    const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
    if (!c.fromEnv && input.url !== undefined) {
      const url = String(input.url).trim();
      if (url && !/^https?:\/\/[^\s/]+(\/[^\s/]+)*\/[A-Za-z0-9_-]{1,64}$/.test(url)) throw bad('Use the full topic URL, e.g. https://ntfy.sh/my-minecraft-alerts');
      c.url = url;
    }
    if (!c.fromEnv && input.token !== undefined) c.token = String(input.token).trim().slice(0, 200);
    if (input.publicUrl !== undefined) {
      const u = String(input.publicUrl).trim().replace(/\/+$/, '');
      if (u && !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(u)) throw bad('rconsole URL must look like https://rconsole.example.com');
      c.publicUrl = u;
    }
    if (input.events) for (const k of Object.keys(EVENTS)) if (typeof input.events[k] === 'boolean') c.events[k] = input.events[k];
    if (input.priorities) for (const k of Object.keys(EVENTS)) if ([1, 2, 3, 4, 5].includes(input.priorities[k])) c.priorities[k] = input.priorities[k];
    if (input.quiet) {
      const q = input.quiet;
      if (q.from !== undefined && !TIME_RE.test(q.from)) throw bad('Quiet hours: use HH:MM');
      if (q.to !== undefined && !TIME_RE.test(q.to)) throw bad('Quiet hours: use HH:MM');
      c.quiet = { enabled: Boolean(q.enabled ?? c.quiet.enabled), from: q.from ?? c.quiet.from, to: q.to ?? c.quiet.to };
    }
    if (input.oneTap !== undefined) c.oneTap = Boolean(input.oneTap);
    const num = (v, min, max, name) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) throw bad(`${name} must be between ${min} and ${max}`);
      return n;
    };
    if (input.tpsBelow !== undefined) c.tpsBelow = num(input.tpsBelow, 1, 20, 'TPS threshold');
    if (input.tpsMinutes !== undefined) c.tpsMinutes = num(input.tpsMinutes, 1, 60, 'Minutes');
    this.save();
    return this.view();
  }

  inQuietHours(now = new Date()) {
    const q = this.config.quiet;
    if (!q.enabled) return false;
    const m = now.getHours() * 60 + now.getMinutes();
    const [f, t] = [q.from, q.to].map((s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3)));
    return f <= t ? m >= f && m < t : m >= f || m < t;
  }

  // --- one-tap actions -------------------------------------------------------

  actionToken(kind, arg) {
    const now = Date.now();
    for (const [t, v] of this.tokens) if (v.exp < now) this.tokens.delete(t);
    const token = crypto.randomBytes(24).toString('base64url');
    this.tokens.set(token, { kind, arg, exp: now + TOKEN_TTL_MS });
    return token;
  }

  // Single use: taken out while it runs (no double execution from a double
  // tap), put back if the action fails so it can be retried.
  async act(token) {
    const t = this.tokens.get(token);
    this.tokens.delete(token);
    if (!t || t.exp < Date.now() || !this.config.oneTap) throw Object.assign(new Error('This action has expired or was already used'), { status: 410 });
    const handler = this.handlers[t.kind];
    if (!handler) throw Object.assign(new Error('Unknown action'), { status: 400 });
    try {
      return { kind: t.kind, arg: t.arg, result: await handler(t.arg) };
    } catch (err) {
      this.tokens.set(token, t);
      throw err;
    }
  }

  httpAction(label, kind, arg) {
    if (!this.config.oneTap || !this.publicUrl || !this.handlers[kind]) return null;
    return { action: 'http', label, url: `${this.publicUrl}/api/notify/act/${this.actionToken(kind, arg)}`, method: 'POST', clear: true };
  }

  // --- publishing ------------------------------------------------------------

  // n: { title, message, key, sequence, view, actions, force, tags }
  async send(event, n) {
    const c = this.config;
    if (!c.url || (!n.force && !c.events[event])) return false;
    const now = Date.now();
    const key = n.key || event;
    if (!n.force) {
      if (event !== 'players' && !n.update && now - (this.last.get(key) || 0) < MIN_GAP_MS) return false;
      this.sentTimes = this.sentTimes.filter((t) => now - t < 3600e3);
      if (this.sentTimes.length >= HOURLY_CAP) return false;
    }
    this.last.set(key, now);
    this.sentTimes.push(now);
    const e = EVENTS[event] || { priority: 3, tags: ['bell'] };
    let priority = n.priority ?? c.priorities[event] ?? e.priority;
    if (priority < 5 && this.inQuietHours()) priority = Math.min(priority, 2);
    const u = new URL(c.url);
    const topic = u.pathname.split('/').pop();
    const root = `${u.origin}${u.pathname.slice(0, -topic.length)}`;
    const click = this.publicUrl ? `${this.publicUrl}/#${n.view || e.view || ''}` : undefined;
    const actions = [
      ...(n.actions || []).filter(Boolean),
      ...(click ? [{ action: 'view', label: 'Open rconsole', url: click, clear: false }] : []),
    ].slice(0, 3);
    const body = {
      topic,
      title: String(n.title).slice(0, 250),
      message: String(n.message).slice(0, MAX_BODY),
      tags: n.tags || e.tags,
      priority,
      ...(click ? { click, icon: `${this.publicUrl}/notify-icon.png` } : {}),
      ...(actions.length ? { actions } : {}),
      ...(n.sequence ? { sequence_id: String(n.sequence).replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64) } : {}),
    };
    try {
      const res = await fetch(root, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}) },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`ntfy answered ${res.status}${res.status === 404 ? ' (is the URL your ntfy server plus topic?)' : ''}`);
      this.log(`notify: sent "${body.title}"`);
      return true;
    } catch (err) {
      this.log(`notify: ${err.message}`);
      if (n.force) throw err;
      return false;
    }
  }

  // A notification that shows what a real one looks like.
  test(user) {
    return this.send('test', {
      title: 'rconsole is connected',
      message: `Notifications work. Sent by ${md(user)}.\n\nAlerts open the matching page in rconsole${this.publicUrl ? '' : ' once the rconsole URL is set'}; follow-ups such as “back up” or “recovered” replace the original alert.`,
      tags: ['white_check_mark'],
      priority: 3,
      view: 'server/overview',
      force: true,
    });
  }

  // --- event sources --------------------------------------------------------

  // Every metrics sample (30 s): up/down, TPS, disk, backups, players.
  onSample(sample, { stats, ops, countdown, backups }) {
    this.onPlayers(stats?.cache?.game?.players?.players);
    const planned = ops?.state?.running || countdown?.remaining != null;
    const up = sample.up === 1;
    if (this.wasUp !== null && up !== this.wasUp) {
      if (!up) {
        this.downSince = Date.now();
        // Only an outage that was announced gets its "back up".
        this.outageAnnounced = this.config.events.down && Date.now() - (this.last.get('down') || 0) >= MIN_GAP_MS;
        this.send('down', planned
          ? { title: 'Minecraft server stopped', message: `Stopped during ${md(ops?.state?.label || 'a scheduled restart')}. You'll get an update here when it's back.`, tags: ['stop_sign'], priority: 3, sequence: 'server-state', key: 'down' }
          : { title: 'Minecraft server is down', message: 'The server stopped responding, or its service is not running.', sequence: 'server-state', key: 'down', actions: [this.httpAction('Start server', 'start', null)] });
      } else if (this.outageAnnounced) {
        const took = this.downSince ? ` after ${ago(Date.now() - this.downSince)}` : '';
        this.send('down', { title: 'Minecraft server is back up', message: `Running again${took}.`, tags: ['white_check_mark'], priority: 3, sequence: 'server-state', key: 'up', update: true });
        this.downSince = null;
      }
    }
    this.wasUp = up;

    const c = this.config;
    if (up && sample.tps != null && sample.tps < c.tpsBelow) this.lowTps++;
    else {
      if (this.tpsAlerted && sample.tps != null) {
        this.send('tps', { title: 'Lag is over', message: `TPS is back at ${sample.tps.toFixed(1)}.`, tags: ['white_check_mark'], priority: 2, sequence: 'tps', key: 'tps-ok', update: true });
      }
      this.lowTps = 0;
      this.tpsAlerted = false;
    }
    if (!this.tpsAlerted && this.lowTps * 30 >= c.tpsMinutes * 60) {
      this.tpsAlerted = true;
      this.send('tps', { title: 'Server is lagging', message: `TPS below ${c.tpsBelow} for ${c.tpsMinutes} min: now ${sample.tps.toFixed(1)}, MSPT ${sample.mspt?.toFixed(0) ?? '?'}, ${sample.players ?? 0} online.`, sequence: 'tps', key: 'tps' });
    }

    const disk = stats?.cache?.host?.disk;
    if (disk?.total) {
      const free = disk.available / disk.total;
      if (free < c.diskBelow && !this.diskAlerted) {
        this.diskAlerted = true;
        this.send('disk', { title: 'Disk almost full', message: `Only ${Math.round(free * 100)}% (${(disk.available / 2 ** 30).toFixed(1)} GB) free. Backups and world saves may fail.`, sequence: 'disk' });
      } else if (free > c.diskBelow * 1.5) this.diskAlerted = false;
    }

    const b = backups?.state;
    if (b?.lastFinishedAt && b.lastFinishedAt !== this.backupSeen) {
      if (this.backupSeen !== null) {
        if (b.lastError) this.send('backup', { title: 'Backup failed', message: `${md(b.lastError)}`, key: `backup-${b.lastFinishedAt}` });
        else this.send('backupOk', { title: 'Backup finished', message: `${md(b.lastFile || 'backup')}`, key: `backupok-${b.lastFinishedAt}` });
      }
      this.backupSeen = b.lastFinishedAt;
    } else if (this.backupSeen === null) this.backupSeen = b?.lastFinishedAt || '';
  }

  // Joins and leaves come from two sources sharing one view of who is
  // online: the server log (immediate, catches short visits) and the player
  // list polled every 30 s (catches servers whose plugins change the join
  // message). Whichever sees a change first reports it; the other agrees.
  // A leave replaces that player's join notification.
  playerEvent(name, joined) {
    if (!this.online) return; // no baseline yet
    if (joined === this.online.has(name)) return;
    if (joined) {
      this.online.add(name);
      this.joinedAt.set(name, Date.now());
    } else this.online.delete(name);
    if (!this.config.events.players || !this.config.url) return;
    const n = this.online.size;
    const others = [...this.online].filter((p) => p !== name);
    if (joined) {
      this.send('players', { title: `${name} joined`, message: `${n} online${others.length ? `: ${others.slice(0, 8).map(md).join(', ')}, ${md(name)}` : ''}.`, sequence: `player-${name}`, key: `p-${name}-in` });
    } else {
      const since = this.joinedAt.get(name);
      this.joinedAt.delete(name);
      this.send('players', { title: `${name} left`, message: `Played ${since ? ago(Date.now() - since) : 'a while'}. ${n} online now.`, tags: ['wave'], priority: Math.min(2, this.config.priorities.players), sequence: `player-${name}`, key: `p-${name}-out` });
    }
  }

  onLogLine(line) {
    const p = parseLine(line);
    const e = p && pickEvent(p);
    if (e?.type === 'join' || e?.type === 'leave') this.playerEvent(e.name, e.type === 'join');
  }

  // A missing list (RCON busy or reconnecting, e.g. while a backup saves the
  // world) keeps the baseline, so joins in the log still count. Only after a
  // longer outage does the next list become a new, silent baseline.
  onPlayers(list) {
    if (!Array.isArray(list)) {
      this.listMissingSince ??= Date.now();
      return;
    }
    const missing = this.listMissingSince;
    this.listMissingSince = null;
    if (!this.online || (missing && Date.now() - missing > this.rebaselineMs)) {
      this.online = new Set(list);
      for (const name of [...this.joinedAt.keys()]) if (!this.online.has(name)) this.joinedAt.delete(name);
      return;
    }
    for (const name of list) this.playerEvent(name, true);
    for (const name of [...this.online]) if (!list.includes(name)) this.playerEvent(name, false);
  }

  // One notification per day, updated as new addresses show up.
  onScanner({ ip, name, reason }) {
    if (this.scanDay.day !== today()) this.scanDay = { day: today(), ips: new Map() };
    const known = this.scanDay.ips.get(ip);
    const entry = known || { names: new Set(), count: 0 };
    entry.count++;
    if (name) entry.names.add(name);
    this.scanDay.ips.set(ip, entry);
    if (known) return; // same address again today: no new alert
    const list = [...this.scanDay.ips].slice(-6).reverse()
      .map(([addr, x]) => `• ${addr}${x.names.size ? ` as ${[...x.names].slice(0, 3).map(md).join(', ')}` : ''}${x.count > 1 ? ` (${x.count}×)` : ''}`);
    const total = this.scanDay.ips.size;
    this.send('scanner', {
      title: total === 1 ? `Unknown connection from ${ip}` : `${total} unknown addresses today`,
      message: `Connected without ever logging in${reason ? ` (${md(reason)})` : ''}, most likely scanners looking for open servers.\n\n${list.join('\n')}${total > 6 ? `\n• … and ${total - 6} more` : ''}`,
      sequence: `scanners-${this.scanDay.day}`,
      key: `scan-${ip}`,
      update: true,
      actions: [IP_RE.test(ip) ? this.httpAction(`Ban ${ip}`, 'ban', ip) : null, { action: 'copy', label: 'Copy IP', value: ip }],
    });
  }

  onAudit(e) {
    if (e.ok) return;
    if (e.action === 'login' && e.error === 'locked out') {
      this.send('security', { title: 'Sign-in locked out', message: `Too many failed sign-ins for ${md(e.user)} from ${md(e.ip)}.`, key: `lock-${e.ip}` });
    } else if (e.user === 'schedule' || e.action === 'operation') {
      this.send('ops', { title: `${e.user === 'schedule' ? 'Scheduled task' : 'Operation'} failed`, message: `${md(e.target)}\n\n${md(e.error || 'failed')}`, key: `ops-${e.target}` });
    }
  }

  // Announces each new version once, as one digest.
  async checkUpdates({ updates, plugins, selfUpdate }) {
    if (!this.config.url || !this.config.events.updates) return;
    const found = [];
    try {
      const o = await updates.overview();
      if (o.newerBuilds?.[0]) found.push([`${o.platform?.id || 'paper'}-${o.newerBuilds[0].id}`, `${md(o.platform?.name || 'Paper')} build ${o.newerBuilds[0].id}`, 'server/updates']);
    } catch {}
    try {
      for (const p of (await plugins.list()).plugins) if (p.update) found.push([`plugin-${p.file}-${p.update.version}`, `${md(p.name)} ${md(p.update.version)}`, 'server/plugins']);
    } catch {}
    try {
      const s = await selfUpdate.overview();
      if (s.check?.status === 'ahead' && s.check.latest) found.push([`self-${s.check.latest.sha}`, `rconsole: ${s.check.behind} new commit${s.check.behind === 1 ? '' : 's'}`, 'server/updates']);
    } catch {}
    const fresh = found.filter(([k]) => !this.config.seen[k]);
    if (!fresh.length) return;
    const sent = await this.send('updates', {
      title: fresh.length === 1 ? 'Update available' : `${fresh.length} updates available`,
      message: fresh.map(([, label]) => `• ${label}`).join('\n'),
      view: fresh[0][2],
      sequence: 'updates',
      key: `updates-${fresh.map(([k]) => k).join()}`,
    });
    if (sent) {
      for (const [k] of fresh) this.config.seen[k] = new Date().toISOString();
      this.save();
    }
  }
}

module.exports = { Notify, EVENTS, PRIORITIES };

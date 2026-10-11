'use strict';

// Daily/weekly scheduled tasks plus the restart countdown they share with the UI.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TYPES = ['restart', 'backup', 'command'];
const ANNOUNCE_AT = [1800, 900, 600, 300, 120, 60, 30, 10, 5, 4, 3, 2, 1];

function humanize(seconds) {
  if (seconds >= 60) {
    const m = Math.round(seconds / 60);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

function nextRun(task, from = new Date()) {
  const [h, m] = task.time.split(':').map(Number);
  for (let i = 0; i <= 7; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (d > from && (!task.days.length || task.days.includes(d.getDay()))) return d;
  }
  return null;
}

function validate(input) {
  const type = String(input.type);
  if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join(', ')}`);
  const time = String(input.time || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('time must be HH:MM');
  const days = [...new Set((input.days || []).map(Number))].filter((d) => d >= 0 && d <= 6).sort();
  const task = { type, time, days, enabled: input.enabled !== false };
  if (type === 'command') {
    task.command = String(input.command || '').trim().replace(/^\//, '');
    if (!task.command) throw new Error('command is required');
  }
  if (type === 'restart') {
    task.warnMinutes = Math.min(60, Math.max(0, Number(input.warnMinutes ?? 5) || 0));
  }
  task.name = String(input.name || '').trim().slice(0, 60);
  return task;
}

// A single shared countdown that ends in `stop`. Minecraft must be supervised
// (e.g. systemd Restart=always) to actually come back up.
// A single shared countdown with in-game warnings. By default it ends in a
// restart: `systemctl restart` when rconsole may control the service, else
// RCON `stop` (Minecraft must then be restarted by systemd Restart=always).
// `finish` replaces that, e.g. a real stop for maintenance or a restore.
class Countdown {
  constructor({ rcon, log, power = null }) {
    Object.assign(this, { rcon, log, power });
    this.endsAt = null;
    this.verb = null;
    this.timers = [];
  }

  get remaining() {
    return this.endsAt ? Math.max(0, Math.round((this.endsAt - Date.now()) / 1000)) : null;
  }

  announce(text) {
    const json = JSON.stringify({ text: `[Server] ${text}`, color: 'gold' });
    return this.rcon.send(`tellraw @a ${json}`).catch(() => {});
  }

  async restart() {
    await this.rcon.send('save-all flush').catch(() => {});
    if (this.power) {
      try {
        await this.power.run('restart');
        this.log('restart: systemctl restart done');
        return;
      } catch (err) {
        this.log(`restart: ${err.message}; falling back to RCON stop`);
      }
    }
    // The server may close the connection before replying to `stop`.
    await this.rcon.send('stop').catch(() => {});
    this.log('restart: stop sent');
  }

  start(seconds, reason = 'Restart', { verb = 'restarting', finish } = {}) {
    this.cancel(false);
    seconds = Math.max(0, Math.round(seconds));
    this.endsAt = Date.now() + seconds * 1000;
    this.verb = verb;
    this.log(`countdown: ${verb} in ${seconds}s (${reason})`);
    if (seconds > 0) this.announce(`Server ${verb} in ${humanize(seconds)}`);
    for (const at of ANNOUNCE_AT) {
      if (at < seconds) {
        this.timers.push(setTimeout(() => this.announce(`Server ${verb} in ${humanize(at)}`), (seconds - at) * 1000));
      }
    }
    return new Promise((resolve, reject) => {
      this.timers.push(
        setTimeout(async () => {
          this.timers = [];
          this.endsAt = null;
          this.reject = null;
          try {
            await (finish ? finish() : this.restart());
            resolve();
          } catch (err) {
            reject(err);
          }
        }, seconds * 1000)
      );
      this.reject = reject;
    });
  }

  cancel(announce = true) {
    if (!this.endsAt) return false;
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.endsAt = null;
    if (this.reject) this.reject(new Error('Countdown cancelled'));
    this.reject = null;
    if (announce) {
      this.announce(`${this.verb === 'restarting' ? 'Restart' : 'Shutdown'} cancelled`);
      this.log('countdown: cancelled');
    }
    return true;
  }
}

class Scheduler {
  constructor({ rcon, backups, countdown, stateDir, log, audit = () => {} }) {
    Object.assign(this, { rcon, backups, countdown, log, audit });
    this.file = path.join(stateDir, 'tasks.json');
    this.tasks = [];
    this.timers = new Map();
  }

  async load() {
    try {
      this.tasks = JSON.parse(await fs.promises.readFile(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') this.log(`scheduler: cannot read ${this.file}: ${err.message}`);
      this.tasks = [];
    }
    this.tasks.forEach((t) => this.arm(t));
  }

  async save() {
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(this.tasks, null, 2));
    await fs.promises.rename(tmp, this.file);
  }

  list() {
    return this.tasks.map((t) => ({ ...t, nextRun: t.enabled ? nextRun(t)?.toISOString() ?? null : null }));
  }

  get(id) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw Object.assign(new Error('Task not found'), { status: 404 });
    return task;
  }

  async create(input) {
    const task = { id: crypto.randomUUID(), ...validate(input), lastRun: null, lastResult: null };
    this.tasks.push(task);
    await this.save();
    this.arm(task);
    return task;
  }

  async update(id, input) {
    const task = this.get(id);
    Object.assign(task, validate({ ...task, ...input }));
    await this.save();
    this.arm(task);
    return task;
  }

  async remove(id) {
    this.get(id);
    this.disarm(id);
    this.tasks = this.tasks.filter((t) => t.id !== id);
    await this.save();
  }

  disarm(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  // Restarts fire early so the countdown ends exactly at the scheduled time.
  arm(task) {
    this.disarm(task.id);
    if (!task.enabled) return;
    const lead = task.type === 'restart' ? task.warnMinutes * 60 * 1000 : 0;
    const now = new Date();
    let at = nextRun(task, new Date(now.getTime() + lead));
    if (!at) return;
    const delay = Math.max(0, at.getTime() - lead - now.getTime());
    this.timers.set(
      task.id,
      setTimeout(() => {
        this.timers.delete(task.id);
        this.execute(task, Math.round((at.getTime() - Date.now()) / 1000)).finally(() => {
          if (this.tasks.includes(task)) this.arm(task);
        });
      }, delay)
    );
  }

  async run(id) {
    const task = this.get(id);
    return this.execute(task, task.type === 'restart' ? task.warnMinutes * 60 : 0);
  }

  async execute(task, countdownSeconds) {
    const label = task.name || `${task.type} ${task.time}`;
    this.log(`scheduler: running "${label}"`);
    let result = 'ok';
    try {
      if (task.type === 'backup') result = `created ${await this.backups.run()}`;
      else if (task.type === 'command') result = (await this.rcon.send(task.command)) || 'ok';
      else if (task.type === 'restart') {
        await this.countdown.start(countdownSeconds, label);
        result = 'restarted';
      }
    } catch (err) {
      result = `error: ${err.message}`;
      this.log(`scheduler: "${label}" failed: ${err.message}`);
    }
    task.lastRun = new Date().toISOString();
    task.lastResult = result.slice(0, 300);
    const failed = result.startsWith('error: ');
    this.audit({ user: 'schedule', action: `task ${task.type}`, target: label, ok: !failed, ...(failed ? { error: result.slice(7, 300) } : {}) });
    if (this.tasks.includes(task)) await this.save().catch(() => {});
    return task.lastResult;
  }
}

module.exports = { Scheduler, Countdown, nextRun };

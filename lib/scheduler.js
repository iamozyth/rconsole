'use strict';

// Automation: tasks that run a chain of steps (warn, wait, command, backup,
// restart, stop, start, "only if nobody is online") on a schedule (daily
// time, or a cron expression) or when something happens (the server
// started, crashed, has been empty for a while, or logged a line). Each
// task belongs to one server; the restart countdown is shared with the UI.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cron = require('./cron');

const ANNOUNCE_AT = [1800, 900, 600, 300, 120, 60, 30, 10, 5, 4, 3, 2, 1];

function humanize(seconds) {
  if (seconds >= 60) {
    const m = Math.round(seconds / 60);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
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


// --- tasks -----------------------------------------------------------------------

const TRIGGERS = ['time', 'cron', 'event'];
const EVENTS = {
  start: 'The server started',
  crash: 'The server stopped unexpectedly',
  empty: 'Nobody has been online for a while',
  log: 'The log shows a line',
};
const STEPS = ['say', 'command', 'wait', 'backup', 'restart', 'stop', 'start', 'if-empty'];
const MAX_STEPS = 10;
// Events the scheduler can only see on the server rconsole shows (players
// and the log come from its RCON and log tail).
const SHOWN_ONLY_EVENTS = new Set(['empty', 'log']);

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const clamp = (v, lo, hi, def) => {
  const n = v === undefined || v === null || v === '' ? def : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};
const oneLine = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

// Tasks saved before 4.6 had one action and a daily time.
function migrate(t) {
  if (t.trigger) return t;
  const steps = t.type === 'restart' ? [{ type: 'restart', warnSeconds: (Number(t.warnMinutes) || 0) * 60 }]
    : t.type === 'backup' ? [{ type: 'backup' }]
      : [{ type: 'command', command: t.command || 'list' }];
  const { type, time, days, warnMinutes, command, ...rest } = t;
  return { ...rest, trigger: { type: 'time', time, days: days || [] }, steps };
}

function validTrigger(input) {
  const t = input && typeof input === 'object' ? input : {};
  const type = String(t.type || '');
  if (!TRIGGERS.includes(type)) throw bad(`The trigger must be one of ${TRIGGERS.join(', ')}`);
  if (type === 'time') {
    const time = String(t.time || '');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw bad('The time must be HH:MM');
    const days = [...new Set((Array.isArray(t.days) ? t.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    return { type, time, days };
  }
  if (type === 'cron') {
    let parsed;
    try {
      parsed = cron.parse(t.cron);
    } catch (err) {
      throw bad(`Cron: ${err.message}`);
    }
    if (!cron.next(parsed)) throw bad('This cron expression never runs');
    return { type, cron: parsed.expr };
  }
  const event = String(t.event || '');
  if (!Object.hasOwn(EVENTS, event)) throw bad(`The event must be one of ${Object.keys(EVENTS).join(', ')}`);
  const out = { type, event, cooldownMinutes: clamp(t.cooldownMinutes, 1, 1440, 10) };
  if (event === 'empty') out.minutes = clamp(t.minutes, 1, 1440, 10);
  if (event === 'log') {
    out.match = oneLine(t.match, 200);
    if (out.match.length < 3) throw bad('Enter at least 3 characters of the log line to watch for');
  }
  return out;
}

function validStep(input, i) {
  const s = input && typeof input === 'object' ? input : {};
  const type = String(s.type || '');
  const where = `Step ${i + 1}`;
  if (!STEPS.includes(type)) throw bad(`${where}: the type must be one of ${STEPS.join(', ')}`);
  switch (type) {
    case 'say': {
      const message = oneLine(s.message, 200);
      if (!message) throw bad(`${where}: enter the message players see`);
      return { type, message };
    }
    case 'command': {
      const command = oneLine(s.command, 1000).replace(/^\//, '');
      if (!command) throw bad(`${where}: enter a command`);
      return { type, command };
    }
    case 'wait':
      return { type, seconds: clamp(s.seconds, 1, 3600, 60) };
    case 'restart':
    case 'stop':
      return { type, warnSeconds: clamp(s.warnSeconds, 0, 3600, 300) };
    default:
      return { type };
  }
}

// kind: 'server' or 'proxy' (Velocity has no worlds, players or tellraw).
function validate(input, { kind = 'server' } = {}) {
  const steps = (Array.isArray(input.steps) ? input.steps : []).map(validStep);
  if (!steps.length) throw bad('Add at least one step');
  if (steps.length > MAX_STEPS) throw bad(`A task has at most ${MAX_STEPS} steps`);
  const trigger = validTrigger(input.trigger);
  if (kind === 'proxy') {
    const no = steps.find((s) => ['say', 'backup', 'if-empty'].includes(s.type));
    if (no) throw bad(`A proxy has no ${no.type === 'backup' ? 'worlds to back up' : 'players to talk to'}; remove the "${no.type}" step`);
    if (SHOWN_ONLY_EVENTS.has(trigger.event)) throw bad('That event is only available for game servers');
  }
  return {
    name: oneLine(input.name, 60),
    enabled: input.enabled !== false,
    server: input.server ?? null,
    trigger,
    steps,
  };
}

// Restarts and stops at the start of a scheduled task begin early, so the
// countdown ends at the set time (as players were told).
function leadSeconds(task) {
  const first = task.steps[0];
  if (task.trigger.type === 'event' || !first || !['restart', 'stop'].includes(first.type)) return 0;
  return first.warnSeconds;
}

function nextRun(task, from = new Date()) {
  const t = task.trigger;
  if (t.type === 'cron') return cron.next(t.cron, from);
  if (t.type !== 'time') return null;
  const [h, m] = t.time.split(':').map(Number);
  for (let i = 0; i <= 7; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (d > from && (!t.days.length || t.days.includes(d.getDay()))) return d;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (server) => server ?? '';

class Scheduler {
  // targets.get(server): what a task's steps act on (see server.js), or
  // throws when that server can't be reached now. targets.kind(server):
  // 'server', 'proxy', or null when there's no such server.
  // defaultServer: the server new tasks and pre-4.6 tasks belong to.
  constructor({ stateDir, log, audit = () => {}, targets, defaultServer = null, sleepFn = sleep }) {
    Object.assign(this, { log, audit, targets, defaultServer, sleep: sleepFn });
    this.file = path.join(stateDir, 'tasks.json');
    this.tasks = [];
    this.timers = new Map();
    this.running = new Map(); // task id -> { step, startedAt }
    this.lastFired = new Map(); // task id -> ms, for event cooldowns
    this.emptySince = new Map(); // server key -> ms since nobody is online
    this.firedEmpty = new Map(); // task id -> the empty period it ran for
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.promises.readFile(this.file, 'utf8'));
      this.tasks = (Array.isArray(raw) ? raw : []).map((t) => ({ server: this.defaultServer, ...migrate(t) }));
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
    return this.tasks.map((t) => ({
      ...t,
      nextRun: t.enabled ? nextRun(t)?.toISOString() ?? null : null,
      lead: leadSeconds(t),
      running: this.running.get(t.id) || null,
    }));
  }

  get(id) {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) throw Object.assign(new Error('Task not found'), { status: 404 });
    return task;
  }

  check(input) {
    const server = input.server === undefined ? this.defaultServer : input.server;
    const kind = this.targets.kind(server);
    if (!kind) throw bad(server ? `No server named ${server}` : 'There is no server to run tasks on');
    return validate({ ...input, server }, { kind });
  }

  async create(input) {
    const task = { id: crypto.randomUUID(), ...this.check(input), lastRun: null, lastResult: null };
    this.tasks.push(task);
    await this.save();
    this.arm(task);
    return task;
  }

  async update(id, input) {
    const task = this.get(id);
    Object.assign(task, this.check({ ...task, ...input }));
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

  arm(task) {
    this.disarm(task.id);
    if (!task.enabled || task.trigger.type === 'event') return;
    const lead = leadSeconds(task) * 1000;
    const now = new Date();
    const at = nextRun(task, new Date(now.getTime() + lead));
    if (!at) return;
    // setTimeout holds at most ~24.8 days; longer waits re-arm on the way.
    const delay = Math.max(0, at.getTime() - lead - now.getTime());
    const MAX = 2 ** 31 - 1;
    this.timers.set(
      task.id,
      setTimeout(() => {
        this.timers.delete(task.id);
        if (delay > MAX) return this.arm(task);
        this.fire(task, { countdown: Math.round((at.getTime() - Date.now()) / 1000), why: 'schedule' }).finally(() => {
          if (this.tasks.includes(task)) this.arm(task);
        });
      }, Math.min(delay, MAX)),
    );
  }

  // Run now from the UI; resolves with the result when the chain is done.
  async run(id, { user } = {}) {
    const task = this.get(id);
    if (this.running.has(id)) throw Object.assign(new Error('This task is running right now'), { status: 409 });
    return this.fire(task, { why: user ? `run by ${user}` : 'run now' });
  }

  // Starts the task unless it's still running from last time.
  async fire(task, { countdown = null, why = '' } = {}) {
    if (this.running.has(task.id)) {
      this.log(`scheduler: "${this.label(task)}" is still running; skipped (${why})`);
      return null;
    }
    this.running.set(task.id, { step: 0, startedAt: new Date().toISOString() });
    try {
      return await this.execute(task, countdown, why);
    } finally {
      this.running.delete(task.id);
    }
  }

  label(task) {
    if (task.name) return task.name;
    const t = task.trigger;
    const what = task.steps.map((s) => s.type).join(' → ');
    return t.type === 'time' ? `${what} ${t.time}` : t.type === 'cron' ? `${what} (${t.cron})` : `${what} on ${t.event}`;
  }

  async execute(task, countdown, why) {
    const label = this.label(task);
    this.log(`scheduler: running "${label}"${why ? ` (${why})` : ''}`);
    const results = [];
    let failed = false;
    try {
      const target = this.targets.get(task.server);
      for (const [i, step] of task.steps.entries()) {
        const state = this.running.get(task.id);
        if (state) state.step = i;
        const out = await this.step(target, step, { label, countdown: i === 0 ? countdown : null });
        if (out?.skip) {
          results.push(out.skip);
          break;
        }
        if (out) results.push(out);
      }
    } catch (err) {
      failed = true;
      results.push(`error: ${err.message}`);
      this.log(`scheduler: "${label}" failed: ${err.message}`);
    }
    task.lastRun = new Date().toISOString();
    task.lastResult = (failed ? results.slice(-1) : results).join(' · ').slice(0, 300) || 'ok';
    this.audit({ user: 'schedule', action: 'task', target: label, ok: !failed, ...(failed ? { error: task.lastResult.slice(7, 300) } : {}) });
    if (this.tasks.includes(task)) await this.save().catch(() => {});
    return task.lastResult;
  }

  // One step; returns a short result, { skip } to end the chain, or nothing.
  async step(target, step, { label, countdown }) {
    switch (step.type) {
      case 'say':
        await target.announce(step.message);
        return null;
      case 'command': {
        const out = String((await target.send(step.command)) ?? '').trim();
        return out ? out.split('\n')[0].slice(0, 120) : `/${step.command.split(' ')[0]}`;
      }
      case 'wait':
        await this.sleep(step.seconds * 1000);
        return null;
      case 'backup':
        return `backup ${await target.backup()}`;
      case 'restart':
        await target.countdown.start(countdown ?? step.warnSeconds, label);
        return 'restarted';
      case 'stop':
        await target.countdown.start(countdown ?? step.warnSeconds, label, { verb: 'stopping', finish: () => target.power.run('stop') });
        return 'stopped';
      case 'start': {
        const st = await target.power.state();
        if (st.active === 'active' || st.active === 'activating') return 'already running';
        await target.power.run('start');
        return 'started';
      }
      case 'if-empty': {
        const n = await target.players();
        if (n == null) throw new Error("can't tell who is online (the server isn't running, or rconsole doesn't show it)");
        return n > 0 ? { skip: `skipped: ${n} player${n === 1 ? '' : 's'} online` } : null;
      }
      default:
        throw new Error(`Unknown step ${step.type}`);
    }
  }

  // --- events ------------------------------------------------------------------

  eventTasks(server, event) {
    return this.tasks.filter((t) => t.enabled && t.trigger.type === 'event' && t.trigger.event === event && keyOf(t.server) === keyOf(server));
  }

  cooled(task, now = Date.now()) {
    const last = this.lastFired.get(task.id);
    return !last || now - last >= task.trigger.cooldownMinutes * 60 * 1000;
  }

  fireEvent(task, why) {
    if (!this.cooled(task)) return;
    this.lastFired.set(task.id, Date.now());
    this.fire(task, { why }).catch((err) => this.log(`scheduler: ${err.message}`));
  }

  // A server's unit changed state. planned: rconsole stopped or restarted
  // it (operation, countdown), so a stop isn't a crash.
  onPower(server, prev, next, { planned = false } = {}) {
    if (!prev || prev.active === next.active) return;
    if (next.active === 'active' && prev.active !== 'active') {
      for (const t of this.eventTasks(server, 'start')) this.fireEvent(t, 'server started');
    }
    const crashed = prev.active === 'active' && !planned && (next.active === 'failed' || (next.result && next.result !== 'success'));
    if (crashed) for (const t of this.eventTasks(server, 'crash')) this.fireEvent(t, `server stopped (${next.result || next.active})`);
  }

  // Players online on the shown server (null: unknown, e.g. stopped).
  onPlayers(server, count, now = Date.now()) {
    const key = keyOf(server);
    if (count == null || count > 0) {
      this.emptySince.delete(key);
      return;
    }
    if (!this.emptySince.has(key)) this.emptySince.set(key, now);
    const since = this.emptySince.get(key);
    for (const t of this.eventTasks(server, 'empty')) {
      if (now - since < t.trigger.minutes * 60 * 1000 || this.firedEmpty.get(t.id) === since) continue;
      this.firedEmpty.set(t.id, since);
      this.fireEvent(t, `nobody online for ${t.trigger.minutes} min`);
    }
  }

  onLogLine(server, line) {
    const text = String(line).toLowerCase();
    for (const t of this.eventTasks(server, 'log')) {
      if (text.includes(t.trigger.match.toLowerCase())) this.fireEvent(t, 'log line');
    }
  }
}

module.exports = { Scheduler, Countdown, nextRun, validate, migrate, leadSeconds, EVENTS, STEPS };

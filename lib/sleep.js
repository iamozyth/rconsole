'use strict';

// Sleep when empty, wake on join. A server nobody played on for a while is
// stopped, and rconsole answers on its port in its place: the multiplayer
// screen shows it as sleeping, and the first player who joins starts it
// again (and is told to join once more in a minute). Settings and state per
// server in STATE_DIR/sleep.json.
//
// While rconsole holds the port the server can't start, so the port is let
// go before anything starts the server: rconsole's own start and restart
// (Power#beforeStart), and anything else (systemctl, a reboot) noticed by
// checking the unit every few seconds.

const fs = require('fs');
const path = require('path');
const { listen } = require('./sleeplistener');

const TICK_MS = 30 * 1000;
const WATCH_MS = 3 * 1000;
const MINUTES = [5, 10, 15, 30, 60, 120];
const DEFAULTS = { enabled: false, minutes: 15, wake: 'known' };
const bad = (status, msg) => Object.assign(new Error(msg), { status });

class Sleeper {
  // targets(): [{ key, name, port, host, power, busy(), players(), known(name) }]
  constructor({ stateDir, targets, log = () => {}, audit = () => {}, onChange = () => {}, now = () => Date.now() }) {
    Object.assign(this, { targets, log, audit, onChange, now });
    this.file = path.join(stateDir, 'sleep.json');
    this.data = { servers: {}, state: {} };
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d && typeof d === 'object') this.data = { servers: d.servers || {}, state: d.state || {} };
    } catch {}
    this.empty = new Map(); // key -> since when nobody is online
    this.listeners = new Map(); // key -> { close }
    this.waking = new Set();
    this.startedAt = now();
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  config(key) {
    return { ...DEFAULTS, ...(this.data.servers[key] || {}) };
  }

  setConfig(key, input) {
    const c = this.config(key);
    if (input.enabled !== undefined) c.enabled = Boolean(input.enabled);
    if (input.minutes !== undefined) {
      if (!MINUTES.includes(Number(input.minutes))) throw bad(400, `Minutes: one of ${MINUTES.join(', ')}`);
      c.minutes = Number(input.minutes);
    }
    if (input.wake !== undefined) {
      if (!['known', 'anyone'].includes(input.wake)) throw bad(400, 'wake: known or anyone');
      c.wake = input.wake;
    }
    this.data.servers[key] = c;
    if (!c.enabled) this.empty.delete(key);
    this.save();
    // Switched off while asleep: it stays stopped, but the port is free.
    if (!c.enabled && this.sleeping(key)) this.release(key, 'sleep switched off').catch(() => {});
    return this.view(key);
  }

  sleeping(key) {
    return Boolean(this.data.state[key]?.sleeping);
  }

  view(key) {
    const st = this.data.state[key] || {};
    const since = this.empty.get(key);
    return {
      ...this.config(key),
      minutesChoices: MINUTES,
      sleeping: Boolean(st.sleeping),
      since: st.since || null,
      woken: st.wokenAt ? { at: st.wokenAt, by: st.wokenBy || null } : null,
      emptySince: since ? new Date(since).toISOString() : null,
      sleepsAt: since && this.config(key).enabled ? new Date(since + this.config(key).minutes * 60000).toISOString() : null,
    };
  }

  start() {
    this.timer = setInterval(() => this.tick().catch((err) => this.log(`sleep: ${err.message}`)), TICK_MS);
    this.timer.unref?.();
    this.watcher = setInterval(() => this.watch().catch(() => {}), WATCH_MS);
    this.watcher.unref?.();
    setTimeout(() => this.tick().catch(() => {}), 20000).unref?.(); // after a reboot the servers start first
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.watcher);
    return Promise.all([...this.listeners.keys()].map((k) => this.closeListener(k)));
  }

  async tick() {
    const list = await this.targets();
    for (const t of list) {
      try {
        await this.check(t);
      } catch (err) {
        this.log(`sleep: ${t.key}: ${err.message}`);
      }
    }
  }

  async check(t) {
    const cfg = this.config(t.key);
    const ps = await t.power.state();
    if (!ps?.available) return;
    if (this.sleeping(t.key)) {
      if (['inactive', 'failed'].includes(ps.active)) {
        if (!this.listeners.has(t.key) && this.now() - this.startedAt > 15000) await this.openListener(t);
      } else await this.release(t.key, 'started');
      return;
    }
    if (!cfg.enabled || ps.active !== 'active' || t.busy()) return this.empty.delete(t.key);
    const n = await t.players().catch(() => null);
    if (n == null || n > 0) return this.empty.delete(t.key);
    if (!this.empty.has(t.key)) this.empty.set(t.key, this.now());
    if (this.now() - this.empty.get(t.key) >= cfg.minutes * 60000) await this.sleep(t);
  }

  // Unit started by something else while asleep: let go of the port at once.
  async watch() {
    if (!this.listeners.size) return;
    const list = await this.targets();
    for (const key of this.listeners.keys()) {
      const t = list.find((x) => x.key === key);
      if (!t) {
        await this.release(key, 'gone');
        continue;
      }
      const ps = await t.power.state().catch(() => null);
      if (ps?.available && !['inactive', 'failed'].includes(ps.active)) await this.release(key, 'started');
    }
  }

  async sleep(t) {
    const minutes = this.config(t.key).minutes;
    this.log(`sleep: ${t.key}: nobody online for ${minutes} min, stopping`);
    this.data.state[t.key] = { sleeping: true, since: new Date(this.now()).toISOString() };
    this.empty.delete(t.key);
    this.save();
    try {
      await t.power.run('stop');
      await t.power.waitFor(['inactive', 'failed']);
    } catch (err) {
      this.data.state[t.key] = { sleeping: false };
      this.save();
      throw err;
    }
    this.audit({ user: 'rconsole', action: 'server sleep', target: `${t.name}: nobody online for ${minutes} min` });
    await this.openListener(t);
    this.onChange(t.key, 'sleep');
  }

  async openListener(t) {
    if (this.listeners.has(t.key)) return;
    try {
      const l = await listen({
        port: t.port,
        host: t.host,
        log: this.log,
        status: () => ({ motd: `💤 ${t.name} is asleep. Join to wake it up.`, version: 'Sleeping', max: t.max || 20 }),
        onLogin: (name, ip) => this.onLogin(t, name, ip),
      });
      this.listeners.set(t.key, l);
      // Anything rconsole starts lets go of the port first.
      t.power.beforeStart = () => this.release(t.key, 'started');
      this.log(`sleep: ${t.key}: answering on port ${t.port}`);
    } catch (err) {
      this.log(`sleep: ${t.key}: can't answer on port ${t.port}: ${err.message}`);
    }
  }

  async closeListener(key) {
    const l = this.listeners.get(key);
    this.listeners.delete(key);
    if (l) await l.close();
  }

  // Awake again (started, switched off): the port goes back to the server.
  async release(key, why) {
    const t = (await this.targets()).find((x) => x.key === key);
    if (t && t.power.beforeStart) t.power.beforeStart = null;
    await this.closeListener(key);
    if (this.sleeping(key)) {
      this.data.state[key] = { ...this.data.state[key], sleeping: false };
      this.save();
      this.log(`sleep: ${key}: awake (${why})`);
      this.onChange(key, 'awake');
    }
  }

  async onLogin(t, name, ip) {
    if (this.waking.has(t.key)) return { text: `${t.name} is starting. Join again in a moment.`, color: 'yellow' };
    if (this.config(t.key).wake === 'known' && !t.known(name)) {
      this.log(`sleep: ${t.key}: ${name} (${ip}) tried to wake it, not a known player`);
      return { text: `${t.name} is asleep, and only its players can wake it.`, color: 'red' };
    }
    this.waking.add(t.key);
    this.log(`sleep: ${t.key}: ${name} (${ip}) wakes it`);
    this.data.state[t.key] = { ...this.data.state[t.key], wokenBy: name, wokenAt: new Date(this.now()).toISOString() };
    this.save();
    this.audit({ user: 'rconsole', action: 'server wake', target: `${t.name}: ${name} joined` });
    // Answer first, then start: the player gets the message right away.
    setImmediate(async () => {
      try {
        await this.release(t.key, `${name} joined`);
        await t.power.run('start');
      } catch (err) {
        this.log(`sleep: ${t.key}: can't start: ${err.message}`);
      } finally {
        this.waking.delete(t.key);
      }
    });
    return { text: `Waking ${t.name} up for you, ${name}. Join again in about a minute.`, color: 'yellow' };
  }
}

// Names that may wake a server: with the whitelist on, the whitelist and
// operators; else everyone who played there (usercache.json) too.
function knownPlayers(dir, whitelistOn) {
  const names = new Set();
  const read = (f) => {
    try {
      const list = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const e of Array.isArray(list) ? list : []) if (typeof e?.name === 'string') names.add(e.name.toLowerCase());
    } catch {}
  };
  read('whitelist.json');
  read('ops.json');
  if (!whitelistOn) read('usercache.json');
  return names;
}

module.exports = { Sleeper, knownPlayers, MINUTES };

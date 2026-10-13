'use strict';

// Game stats via RCON and host stats from the OS.

const fs = require('fs');
const os = require('os');

function parsePlayers(output) {
  // "There are 2 of a max of 20 players online: Alex, Steve"
  const m = output.match(/There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)/i);
  if (!m) return null;
  const players = m[3].split(',').map((s) => s.trim()).filter(Boolean);
  return { online: Number(m[1]), max: Number(m[2]), players };
}

// Paper/Spigot have `tps`; vanilla 1.20.3+ has `tick query`. Detected once.
const tpsProbes = [
  {
    command: 'tps',
    parse(out) {
      const m = out.match(/TPS from last[^:]*:\s*\*?([\d.]+)/i);
      if (!m) return null;
      const tps = Number(m[1]);
      return { tps, mspt: null };
    },
  },
  {
    command: 'tick query',
    parse(out) {
      const m = out.match(/Average time per tick:\s*([\d.]+)\s*ms/i);
      if (!m) return null;
      const mspt = Number(m[1]);
      const rate = Number((out.match(/Target tick rate:\s*([\d.]+)/i) || [])[1]) || 20;
      return { tps: Math.min(rate, 1000 / Math.max(mspt, 0.001)), mspt };
    },
  },
];

// Every RCON command waits for the server's main thread, so values that
// change slowly are asked for less often: TPS every 10 s, the player list
// every 30 s (and right after a join or leave in the log), the game time
// once a minute, advanced locally in between.
const TPS_MS = 10 * 1000;
const PLAYERS_MS = 30 * 1000;
const TIME_MS = 60 * 1000;

class Stats {
  constructor({ rcon, mcDir, now = Date.now }) {
    this.rcon = rcon;
    this.mcDir = mcDir;
    this.now = now;
    this.tpsProbe = undefined; // undefined = not yet detected, null = unsupported
    this.cpuSample = cpuTimes();
    this.cache = null;
    this.cacheAt = 0;
    this.slow = {}; // name -> { value, at }
  }

  // After a join or leave, or a command that may change the time.
  invalidate(...names) {
    for (const n of names.length ? names : Object.keys(this.slow)) delete this.slow[n];
    this.cacheAt = 0;
  }

  async every(name, ms, fetch) {
    const hit = this.slow[name];
    if (hit && this.now() - hit.at < ms) return hit.value;
    const value = await fetch();
    this.slow[name] = { value, at: this.now() };
    return value;
  }

  async tps() {
    if (this.tpsProbe === undefined) {
      for (const probe of tpsProbes) {
        const result = probe.parse(await this.rcon.send(probe.command));
        if (result) {
          this.tpsProbe = probe;
          return result;
        }
      }
      this.tpsProbe = null;
    }
    if (!this.tpsProbe) return null;
    const result = this.tpsProbe.parse(await this.rcon.send(this.tpsProbe.command));
    if (!result) this.tpsProbe = undefined; // server software changed; re-detect next time
    return result;
  }

  async game() {
    try {
      const players = await this.every('players', PLAYERS_MS, async () => parsePlayers(await this.rcon.send('list')));
      const tps = await this.every('tps', TPS_MS, () => this.tps());
      const time = await this.every('time', TIME_MS, () => this.gameTime());
      return { players, ...this.advance(time, tps?.tps), ...tps };
    } catch (err) {
      this.invalidate(); // offline: ask afresh once it's back
      throw err;
    }
  }

  // The last asked game time, moved on by the ticks since (20 per second at
  // full speed). Off by a little when the daylight cycle is stopped; the next
  // query a minute later corrects it.
  advance(time, tps) {
    const at = this.slow.time?.at;
    if (time.daytime == null || !at) return time;
    const ticks = Math.floor(((this.now() - at) / 1000) * Math.min(20, tps || 20));
    const total = time.daytime + ticks;
    return { daytime: total % 24000, day: time.day == null ? null : time.day + Math.floor(total / 24000) };
  }

  // 26.x: `time query day` → "Timeline minecraft:day is at 21842 tick(s)" and
  // `daytime` no longer exists. Older: "The time is 42" (day count) plus
  // `time query daytime` → "The time is 6000". Asked in this order so new
  // servers don't log an unknown-element error every poll.
  async gameTime() {
    const dayOut = await this.rcon.send('time query day');
    const timeline = dayOut.match(/Timeline minecraft:day is at (\d+)/i);
    if (timeline) {
      const ticks = Number(timeline[1]);
      return { daytime: ticks % 24000, day: ticks >= 24000 ? Math.floor(ticks / 24000) : null };
    }
    const day = Number(dayOut.match(/The time is (\d+)/i)?.[1]);
    if (!Number.isFinite(day)) return { daytime: null, day: null };
    const daytime = Number((await this.rcon.send('time query daytime')).match(/The time is (\d+)/i)?.[1]);
    return { daytime: Number.isFinite(daytime) ? daytime : null, day };
  }

  async host() {
    const now = cpuTimes();
    const idle = now.idle - this.cpuSample.idle;
    const total = now.total - this.cpuSample.total;
    this.cpuSample = now;

    let mem = { total: os.totalmem(), available: os.freemem() };
    try {
      const info = await fs.promises.readFile('/proc/meminfo', 'utf8');
      const kb = (key) => Number(info.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1]) * 1024;
      mem = { total: kb('MemTotal'), available: kb('MemAvailable') };
    } catch {}

    let disk = null;
    try {
      const s = await fs.promises.statfs(this.mcDir);
      disk = { total: s.blocks * s.bsize, available: s.bavail * s.bsize };
    } catch {}

    return {
      cpu: total > 0 ? 1 - idle / total : null,
      cores: os.cpus().length,
      load: os.loadavg(),
      mem,
      disk,
      uptime: os.uptime(),
    };
  }

  // Cached briefly so several open tabs don't multiply RCON traffic.
  async get() {
    if (this.cache && this.now() - this.cacheAt < 4000) return this.cache;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const host = await this.host();
      let game = null;
      let error = null;
      try {
        game = await this.game();
      } catch (err) {
        error = err.message;
      }
      this.cache = { rcon: { ok: !error, error }, game, host };
      this.cacheAt = this.now();
      return this.cache;
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [k, v] of Object.entries(cpu.times)) {
      total += v;
      if (k === 'idle') idle += v;
    }
  }
  return { idle, total };
}

module.exports = { Stats, parsePlayers };

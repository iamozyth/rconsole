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

class Stats {
  constructor({ rcon, mcDir }) {
    this.rcon = rcon;
    this.mcDir = mcDir;
    this.tpsProbe = undefined; // undefined = not yet detected, null = unsupported
    this.cpuSample = cpuTimes();
    this.cache = null;
    this.cacheAt = 0;
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
    const players = parsePlayers(await this.rcon.send('list'));
    const daytime = Number((await this.rcon.send('time query daytime')).match(/(\d+)/)?.[1]);
    const day = Number((await this.rcon.send('time query day')).match(/(\d+)/)?.[1]);
    const tps = await this.tps();
    return { players, daytime: Number.isFinite(daytime) ? daytime : null, day: Number.isFinite(day) ? day : null, ...tps };
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
    if (this.cache && Date.now() - this.cacheAt < 4000) return this.cache;
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
      this.cacheAt = Date.now();
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

'use strict';

// Start/stop the Minecraft service through systemd. Reading state needs no
// privilege; start/stop/restart are allowed for the rconsole user by polkit,
// for this one unit only.

const fs = require('fs');
const { spawn } = require('child_process');

const UNIT_RE = /^[A-Za-z0-9@._-]+\.service$/;

function exec(args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const child = spawn('systemctl', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ code: -1, out: '', err: e.message }));
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

class Power {
  constructor({ unit, log }) {
    if (!UNIT_RE.test(unit)) throw new Error(`Invalid MC_SERVICE ${unit}`);
    Object.assign(this, { unit, log });
    this.pending = null; // the action in flight, if any
    this.cache = null;
    this.cacheAt = 0;
    this.cpu = null; // previous process CPU sample
  }

  async state() {
    if (this.cache && Date.now() - this.cacheAt < 2000) return this.cache;
    const { code, out, err } = await exec(['show', this.unit, '-p', 'ActiveState,SubState,MainPID,ActiveEnterTimestamp,LoadState,Result']);
    if (code !== 0) {
      this.cache = { available: false, error: err || 'systemctl unavailable', pending: this.pending };
    } else {
      const p = Object.fromEntries(out.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      const since = Date.parse(p.ActiveEnterTimestamp);
      this.cache = {
        available: p.LoadState === 'loaded',
        unit: this.unit,
        active: p.ActiveState,
        sub: p.SubState,
        result: p.Result,
        pid: Number(p.MainPID) || null,
        since: Number.isFinite(since) ? new Date(since).toISOString() : null,
        pending: this.pending,
      };
    }
    this.cacheAt = Date.now();
    return this.cache;
  }

  // Minecraft process memory and CPU from /proc; null when not readable.
  async processStats() {
    const s = await this.state();
    if (!s.pid) return null;
    try {
      const status = await fs.promises.readFile(`/proc/${s.pid}/status`, 'utf8');
      const stat = (await fs.promises.readFile(`/proc/${s.pid}/stat`, 'utf8')).split(') ')[1].split(' ');
      const ticks = Number(stat[11]) + Number(stat[12]); // utime + stime
      const now = Date.now();
      let cpu = null;
      if (this.cpu && this.cpu.pid === s.pid) cpu = (ticks - this.cpu.ticks) / 100 / ((now - this.cpu.at) / 1000);
      this.cpu = { pid: s.pid, ticks, at: now };
      const rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]) * 1024;
      return { rss: Number.isFinite(rss) ? rss : null, cpu };
    } catch {
      return null;
    }
  }

  async run(action) {
    if (!['start', 'stop', 'restart'].includes(action)) throw Object.assign(new Error('Invalid action'), { status: 400 });
    if (this.pending) throw Object.assign(new Error(`Already running: ${this.pending}`), { status: 409 });
    this.pending = action;
    this.cache = null;
    this.log(`power: ${action} ${this.unit}`);
    try {
      // `stop` waits for a clean shutdown (TimeoutStopSec on the unit).
      const { code, err } = await exec([action, this.unit], 5 * 60 * 1000);
      if (code !== 0) {
        if (/interactive authentication|access denied|not authorized/i.test(err)) {
          throw new Error(`Not allowed to ${action} ${this.unit}. Install the polkit rule (see README).`);
        }
        throw new Error(err || `systemctl ${action} failed (exit ${code})`);
      }
    } finally {
      this.pending = null;
      this.cache = null;
    }
  }

  async waitFor(states, timeoutMs = 120000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      this.cache = null;
      const s = await this.state();
      if (states.includes(s.active)) return s;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${this.unit} to be ${states.join('/')}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

module.exports = { Power };

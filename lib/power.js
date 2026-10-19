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

// systemd prints "Sun 2026-10-11 23:26:47 CEST" (or "@1760218007" with
// --timestamp=unix), neither of which Date.parse understands. The zone name
// is the host's own, which is also rconsole's local time.
function parseTimestamp(v) {
  if (!v || v === 'n/a') return null;
  const unix = String(v).match(/^@(\d+)/);
  if (unix) return Number(unix[1]) * 1000;
  const m = String(v).match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (m) return new Date(m[1], m[2] - 1, m[3], m[4], m[5], m[6]).getTime();
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

class Power {
  // resetFailed: clear a hit start limit before starting (polkit allows it
  // for the rconsole-mc@ units).
  constructor({ unit, log, resetFailed = false }) {
    if (!UNIT_RE.test(unit)) throw new Error(`Invalid MC_SERVICE ${unit}`);
    Object.assign(this, { unit, log, resetFailed });
    this.pending = null; // the action in flight, if any
    this.cache = null;
    this.cacheAt = 0;
    this.cpu = null; // previous process CPU sample
  }

  // Requests that arrive together share one systemctl call.
  state() {
    if (this.cache && Date.now() - this.cacheAt < 2000) return Promise.resolve(this.cache);
    this.inflight ??= this.query().finally(() => (this.inflight = null));
    return this.inflight;
  }

  async query() {
    const props = ['show', this.unit, '-p', 'ActiveState,SubState,MainPID,ActiveEnterTimestamp,LoadState,Result'];
    let { code, out, err } = await exec([...props, '--timestamp=unix']);
    if (code !== 0 && /timestamp/i.test(err)) ({ code, out, err } = await exec(props)); // systemd < 248
    if (code !== 0) {
      this.cache = { available: false, error: err || 'systemctl unavailable', pending: this.pending };
    } else {
      const p = Object.fromEntries(out.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      const since = parseTimestamp(p.ActiveEnterTimestamp);
      this.cache = {
        available: p.LoadState === 'loaded',
        unit: this.unit,
        active: p.ActiveState,
        sub: p.SubState,
        result: p.Result,
        pid: Number(p.MainPID) || null,
        since: since ? new Date(since).toISOString() : null,
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
      // A unit that crashed too often in a row refuses to start until its
      // failure is cleared (StartLimitBurst); an admin's Start clears it.
      if (action !== 'stop' && this.resetFailed) await exec(['reset-failed', this.unit]);
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

module.exports = { parseTimestamp, Power };

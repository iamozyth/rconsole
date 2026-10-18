'use strict';

// Metrics history: a sample every 30 s kept for 24 h, and 5-minute averages
// kept for 7 days. Persisted to STATE_DIR/metrics.json every 5 minutes and on
// shutdown, so a restart of rconsole only loses the last few minutes.

const fs = require('fs');
const path = require('path');

// heap: share of the Java heap holding live data (servers rconsole runs).
const FIELDS = ['tps', 'mspt', 'players', 'cpu', 'mem', 'rss', 'heap', 'pcpu', 'up'];
const FINE = { step: 30, keep: (24 * 3600) / 30 };
const COARSE = { step: 300, keep: (7 * 24 * 3600) / 300 };
const SAVE_MS = 5 * 60 * 1000;
const RANGES = { '1h': [3600, 'fine'], '6h': [6 * 3600, 'fine'], '24h': [24 * 3600, 'fine'], '7d': [7 * 24 * 3600, 'coarse'] };

const round = (v, d = 3) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

// Mean of each field over a group of samples, ignoring gaps.
function average(samples, t) {
  const out = { t };
  for (const f of FIELDS) {
    const vals = samples.map((s) => s[f]).filter((v) => v != null);
    out[f] = vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }
  // Players: the peak is more telling than the mean.
  const players = samples.map((s) => s.players).filter((v) => v != null);
  out.players = players.length ? Math.max(...players) : null;
  return out;
}

class Metrics {
  constructor({ stats, power, stateDir, log = () => {} }) {
    Object.assign(this, { stats, power, log });
    this.file = path.join(stateDir, 'metrics.json');
    this.fine = [];
    this.coarse = [];
    this.bucket = [];
    this.listeners = new Set();
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const cutoff = (now, keep, step) => now - keep * step * 1000;
      const now = Date.now();
      this.fine = (data.fine || []).filter((s) => s.t > cutoff(now, FINE.keep, FINE.step));
      this.coarse = (data.coarse || []).filter((s) => s.t > cutoff(now, COARSE.keep, COARSE.step));
    } catch {}
  }

  async save() {
    try {
      const tmp = `${this.file}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify({ fine: this.fine, coarse: this.coarse }), { mode: 0o600 });
      await fs.promises.rename(tmp, this.file);
    } catch (err) {
      this.log(`metrics: can't save: ${err.message}`);
    }
  }

  saveSync() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ fine: this.fine, coarse: this.coarse }), { mode: 0o600 });
    } catch {}
  }

  start() {
    const align = FINE.step * 1000 - (Date.now() % (FINE.step * 1000));
    this.timeout = setTimeout(() => {
      this.sample();
      this.timer = setInterval(() => this.sample(), FINE.step * 1000);
    }, align);
    this.saver = setInterval(() => this.save(), SAVE_MS);
    for (const t of [this.timeout, this.saver]) t.unref?.();
  }

  stop() {
    clearTimeout(this.timeout);
    clearInterval(this.timer);
    clearInterval(this.saver);
    this.saveSync();
  }

  onSample(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async sample() {
    try {
      const s = await this.stats.get();
      const st = await this.power.state().catch(() => ({}));
      const proc = await this.power.processStats().catch(() => null);
      const host = s.host || {};
      const game = s.game || {};
      const up = st.available ? (st.active === 'active' ? 1 : 0) : s.rcon?.ok ? 1 : 0;
      this.add({
        t: Math.floor(Date.now() / 1000 / FINE.step) * FINE.step * 1000,
        tps: round(game.tps, 2),
        mspt: round(game.mspt, 2),
        players: game.players ? game.players.online : null,
        cpu: round(host.cpu),
        mem: host.mem?.total ? round(1 - host.mem.available / host.mem.total) : null,
        rss: proc?.rss ?? null,
        heap: s.heap?.used != null && s.heap.max ? round(s.heap.used / s.heap.max) : null,
        pcpu: proc?.cpu == null ? null : round(proc.cpu / (host.cores || 1)),
        up,
      });
    } catch (err) {
      this.log(`metrics: sample failed: ${err.message}`);
    }
  }

  add(sample) {
    this.fine.push(sample);
    if (this.fine.length > FINE.keep) this.fine.splice(0, this.fine.length - FINE.keep);
    const slot = Math.floor(sample.t / (COARSE.step * 1000)) * COARSE.step * 1000;
    if (this.bucket.length && this.bucketSlot !== slot) {
      this.coarse.push(average(this.bucket, this.bucketSlot));
      if (this.coarse.length > COARSE.keep) this.coarse.splice(0, this.coarse.length - COARSE.keep);
      this.bucket = [];
    }
    this.bucketSlot = slot;
    this.bucket.push(sample);
    for (const fn of this.listeners) fn(sample);
  }

  latest() {
    return this.fine[this.fine.length - 1] || null;
  }

  // Columnar series for charts: { step, from, to, t: [...], tps: [...], ... }
  series(range = '24h') {
    const [span, res] = RANGES[range] || RANGES['24h'];
    const now = Date.now();
    const from = now - span * 1000;
    let rows = res === 'fine' ? this.fine : this.coarse;
    if (res === 'coarse') {
      // Fill in from the 30 s samples where no 5-minute average exists yet
      // (fresh install, the current slot, or after rconsole was down).
      const step = COARSE.step * 1000;
      const lastSlot = rows.length ? rows[rows.length - 1].t : -Infinity;
      const groups = new Map();
      for (const s of this.fine) {
        const slot = Math.floor(s.t / step) * step;
        if (slot <= lastSlot) continue;
        if (!groups.has(slot)) groups.set(slot, []);
        groups.get(slot).push(s);
      }
      rows = [...rows, ...[...groups].map(([slot, g]) => average(g, slot))];
    }
    rows = rows.filter((s) => s.t >= from);
    const out = { range, step: (res === 'fine' ? FINE : COARSE).step, from, to: now, t: rows.map((r) => r.t) };
    for (const f of FIELDS) out[f] = rows.map((r) => r[f] ?? null);
    return out;
  }
}

module.exports = { Metrics, average, FIELDS, RANGES };

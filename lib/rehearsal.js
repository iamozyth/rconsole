'use strict';

// Update rehearsal: before an update, a copy of the server starts once with
// what it runs now and once with the update, next to the real server, which
// keeps running. What the update changes about starting up (new warnings
// and errors, plugins that no longer load, a server that doesn't come up at
// all) is what to know before players do. The copy is made by the helper
// (bin/mc-rehearsal.js), cut off from the internet, and removed afterwards.
// Results are kept in STATE_DIR/rehearsals.json (the last 10).

const fs = require('fs');
const path = require('path');

const KEEP = 10;
const SUPPORTED = new Set(['paper', 'folia', 'purpur', 'vanilla', 'forge', 'neoforge']);
const MIN_MB = 1024;
const SPARE_MB = 768;
const bad = (status, msg) => Object.assign(new Error(msg), { status });

// [00:25:37 WARN]: msg (Paper's console), [00:25:37] [Server thread/WARN]: msg
// (vanilla, Forge, latest.log).
const LEVEL = /^\[[^\]]*?\b(WARN|ERROR|FATAL)\](?::| \[[^\]]*\]:?)?\s*(.*)$|^\[[^\]]*\] \[[^\]]*\/(WARN|ERROR|FATAL)\](?: \[[^\]]*\])?:?\s*(.*)$/;
const TRACE = /^\s+at |^\s*Caused by|^\s*\.\.\. \d+ more|^[a-z][\w$.]*(Exception|Error)(:|$)/;
const message = (line) => line.replace(/^\[[^\]]*\](?: \[[^\]]*\])?:?\s*/, '');

// The same problem in both starts, whatever the numbers in it.
const keyOf = (text) => text.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/gi, 'U').replace(/\d+(\.\d+)*/g, '#').replace(/\s+/g, ' ').trim().slice(0, 200);

function analyze(boot) {
  const lines = boot?.notable || [];
  const done = lines.findIndex((l) => /Done \(\d/.test(l));
  const stopping = lines.findIndex((l) => /Stopping server/.test(l));
  const end = stopping === -1 ? lines.length : stopping;
  const problems = new Map();
  let last = null;
  for (const line of lines.slice(0, end)) {
    const m = LEVEL.exec(line);
    if (m) {
      const level = m[1] || m[3];
      const text = (m[2] ?? m[4] ?? '').trim();
      if (!text) continue;
      const key = `${level === 'WARN' ? 'warning' : 'error'}:${keyOf(text)}`;
      const p = problems.get(key) || { key, level: level === 'WARN' ? 'warning' : 'error', text: text.slice(0, 300), count: 0, detail: [] };
      p.count++;
      problems.set(key, p);
      last = p;
    } else if (last && TRACE.test(line) && last.detail.length < 6) last.detail.push(line.trim().slice(0, 200));
    else if (!TRACE.test(line)) last = null;
  }
  const before = lines.slice(0, done === -1 ? end : done);
  const plugins = {};
  const failed = new Set();
  for (const line of before) {
    const msg = message(line);
    let m = /^\[([^\]\s]+)\] Enabling (\S+) v?(\S+)/.exec(msg);
    if (m && m[1] === m[2]) plugins[m[1]] = m[3];
    if ((m = /Error occurred while enabling (\S+)/.exec(msg))) failed.add(m[1]);
    if ((m = /Could not load '(?:plugins[/\\])?([^']+?)(?:\.jar)?'/.exec(msg))) failed.add(m[1]);
    if ((m = /^\[([^\]\s]+)\] Disabling \1\b/.exec(msg))) failed.add(m[1]);
  }
  for (const f of failed) delete plugins[f];
  return { up: Boolean(boot?.up), seconds: boot?.seconds ?? null, problems: [...problems.values()], plugins, failed: [...failed] };
}

// The update's start against the current one.
function compare(currentBoot, nextBoot) {
  const a = analyze(currentBoot);
  const b = analyze(nextBoot);
  const had = new Set(a.problems.map((p) => p.key));
  const has = new Set(b.problems.map((p) => p.key));
  const added = b.problems.filter((p) => !had.has(p.key)).sort((x, y) => (x.level === y.level ? 0 : x.level === 'error' ? -1 : 1));
  const lost = Object.keys(a.plugins).filter((n) => !(n in b.plugins)).sort();
  const changed = Object.keys(b.plugins).filter((n) => n in a.plugins && a.plugins[n] !== b.plugins[n]);
  const verdict = !a.up ? 'inconclusive' : !b.up ? 'fails' : added.some((p) => p.level === 'error') || lost.length ? 'problems' : added.length ? 'warnings' : 'works';
  const why = (boot) => (boot?.error ? boot.error : boot?.timedOut ? 'It did not finish starting within 6 minutes.' : boot?.exit != null ? `It stopped with exit code ${boot.exit} before it was up.` : null);
  return {
    verdict,
    current: { up: a.up, seconds: a.seconds, plugins: Object.keys(a.plugins).length, problems: a.problems.length, why: a.up ? null : why(currentBoot) },
    next: { up: b.up, seconds: b.seconds, plugins: Object.keys(b.plugins).length, problems: b.problems.length, why: b.up ? null : why(nextBoot) },
    added: added.slice(0, 40),
    gone: a.problems.filter((p) => !has.has(p.key)).length,
    lostPlugins: lost,
    changedPlugins: changed,
    // What a failed start said last; the crash report if there is one.
    tail: b.up ? null : (nextBoot?.tail || []).slice(-25),
    crash: b.up ? null : nextBoot?.crash || null,
    currentTail: a.up ? null : (currentBoot?.tail || []).slice(-25),
  };
}

function memAvailableMb() {
  try {
    return Number(/^MemAvailable:\s+(\d+)/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 1024;
  } catch {
    return null;
  }
}

class Rehearsal {
  // instance(): the active server rconsole installed, or null.
  constructor({ jobs, instance, stateDir, log = () => {}, memAvailable = memAvailableMb, now = () => Date.now() }) {
    Object.assign(this, { jobs, instance, log, memAvailable, now });
    this.file = path.join(stateDir, 'rehearsals.json');
    this.results = [];
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(d.results)) this.results = d.results.slice(0, KEEP);
    } catch {}
    this.state = { running: false, step: null, target: null, startedAt: null, error: null };
    this.running = null;
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ results: this.results }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // Why this server can't be rehearsed, or null.
  unavailable() {
    const inst = this.instance();
    if (!inst) return 'Rehearsals work for servers rconsole installed (Servers → New server).';
    if (inst.kind === 'proxy') return 'Proxies are not rehearsed; try the servers behind them.';
    if (!SUPPORTED.has(inst.distribution)) return `Rehearsals aren't available for ${inst.distribution} servers yet.`;
    return null;
  }

  view() {
    const inst = this.instance();
    return {
      available: !this.unavailable(),
      reason: this.unavailable(),
      state: this.state,
      results: this.results.filter((r) => !inst || r.server === inst.id).map(({ id, at, by, server, from, to, verdict, current, next, added, lostPlugins, error }) => ({
        id, at, by, server, from, to, verdict, error, seconds: [current?.seconds ?? null, next?.seconds ?? null], added: added?.length ?? 0, lostPlugins: lostPlugins?.length ?? 0,
      })),
    };
  }

  result(id) {
    const r = this.results.find((x) => x.id === id);
    if (!r) throw bad(404, 'No such rehearsal');
    return r;
  }

  start({ version, build = null }, user) {
    if (this.running) throw bad(409, 'A rehearsal is already running');
    const why = this.unavailable();
    if (why) throw bad(409, why);
    if (!/^\d+(\.\d+)+$/.test(String(version || ''))) throw bad(400, 'Invalid version');
    const inst = this.instance();
    const avail = this.memAvailable();
    const memoryMb = Math.min(inst.memoryMb, Math.floor((avail ?? inst.memoryMb + SPARE_MB) - SPARE_MB));
    if (memoryMb < MIN_MB) throw bad(409, `Not enough free memory to start a copy next to the running server: it needs ${MIN_MB + SPARE_MB} MB free, ${Math.round(avail)} MB are.`);
    const target = `${version}${build != null ? ` ${typeof build === 'number' ? '#' : ''}${build}` : ''}`;
    const r = {
      id: `${this.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at: new Date(this.now()).toISOString(), by: user || null, server: inst.id,
      from: { version: inst.version, build: inst.build ?? null }, to: { version, build },
    };
    this.state = { running: true, step: 'copying the server and fetching the update', target, startedAt: r.at, error: null, id: r.id };
    this.log(`rehearsal: ${user} tries ${inst.id} on ${target} (${memoryMb} MB)`);
    const step = (s) => {
      this.state.step = s;
      this.log(`rehearsal: ${s}`);
    };
    this.running = (async () => {
      let token = null;
      try {
        const prep = await this.jobs.run('rehearsal-prepare', { id: inst.id, version, build, memoryMb }, { timeoutMs: 30 * 60 * 1000 });
        token = prep.token;
        r.to = { version: prep.next.version, build: prep.next.build };
        r.copied = prep.copied;
        step('starting the current version');
        const current = await this.jobs.run('rehearsal-boot', { token, which: 'current' }, { timeoutMs: 12 * 60 * 1000 });
        step('starting the update');
        const next = await this.jobs.run('rehearsal-boot', { token, which: 'next' }, { timeoutMs: 12 * 60 * 1000 });
        step('comparing');
        Object.assign(r, compare(current, next));
      } catch (err) {
        r.verdict = 'error';
        r.error = err.message;
        this.state.error = err.message;
        this.log(`rehearsal: failed: ${err.message}`);
      } finally {
        if (token) await this.jobs.run('rehearsal-clean', { token }).catch((err) => this.log(`rehearsal: clean-up: ${err.message}`));
      }
      this.results.unshift(r);
      this.results = this.results.slice(0, KEEP);
      this.save();
      this.log(`rehearsal: ${r.verdict}`);
    })().finally(() => {
      this.state = { ...this.state, running: false, step: null, finishedAt: new Date(this.now()).toISOString() };
      this.running = null;
    });
    return this.state;
  }
}

module.exports = { Rehearsal, analyze, compare, SUPPORTED };

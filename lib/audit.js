'use strict';

// Structured audit trail: one JSON object per line in STATE_DIR/audit.jsonl,
// rotated to audit.jsonl.1 at 5 MB (so at most ~10 MB on disk).

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 5 * 1024 * 1024;
const SECRET_KEYS = /pass|secret|token|code|totp/i;

// Keeps request bodies readable in the log without storing credentials or
// anything large.
function summarize(body) {
  if (!body || typeof body !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (SECRET_KEYS.test(k)) continue;
    if (v && typeof v === 'object') out[k] = JSON.stringify(v).slice(0, 300);
    else if (typeof v === 'string') out[k] = v.slice(0, 300);
    else out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

class Audit {
  constructor({ stateDir, log = () => {} }) {
    this.file = path.join(stateDir, 'audit.jsonl');
    this.log = log;
    this.queue = Promise.resolve();
  }

  // { user, ip, action, target, detail, ok, error }
  record(entry) {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ok: true, ...entry })}\n`;
    this.queue = this.queue.then(async () => {
      try {
        const size = (await fs.promises.stat(this.file).catch(() => ({ size: 0 }))).size;
        if (size + line.length > MAX_BYTES) await fs.promises.rename(this.file, `${this.file}.1`);
        await fs.promises.appendFile(this.file, line, { mode: 0o600 });
      } catch (err) {
        this.log(`audit: can't write ${this.file}: ${err.message}`);
      }
    });
    return this.queue;
  }

  async read(file) {
    try {
      return (await fs.promises.readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  // Newest first.
  async query({ user, action, q, failed, limit = 200 } = {}) {
    await this.queue;
    const all = [...(await this.read(`${this.file}.1`)), ...(await this.read(this.file))].reverse();
    const needle = String(q || '').toLowerCase();
    const out = [];
    const users = new Set();
    const actions = new Set();
    for (const e of all) {
      users.add(e.user);
      actions.add(e.action.split(' ')[0]);
      if (user && e.user !== user) continue;
      if (action && e.action.split(' ')[0] !== action) continue;
      if (failed && e.ok) continue;
      if (needle && !JSON.stringify(e).toLowerCase().includes(needle)) continue;
      if (out.length < limit) out.push(e);
    }
    return { entries: out, total: all.length, users: [...users].filter(Boolean).sort(), actions: [...actions].sort() };
  }
}

module.exports = { Audit, summarize };

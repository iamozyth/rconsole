'use strict';

// Live view of connection attempts that never logged in, from addresses no
// player has ever logged in from. Seeded from player history at startup,
// then fed by the log tail. Drives the warning in the UI and the ntfy alert.

const { parseLine } = require('./logfiles');
const { pickEvent, isPrivateIp } = require('./players');

const DAY = 24 * 3600 * 1000;

class Scanners {
  // skip(name, reason): attempts that are someone else's business, such as a
  // real player turned away by the whitelist (lib/joinrequests.js).
  constructor({ onAttempt = () => {}, skip = () => false } = {}) {
    this.onAttempt = onAttempt;
    this.skip = skip;
    this.knownIps = new Set();
    this.recent = []; // { ip, name, reason, t } from unknown public addresses
    this.ready = false; // live lines count only after seeding (the tail replays the log's end at startup)
  }

  seed({ players = [], attempts = [] }) {
    this.ready = true;
    for (const p of players) if (p.ip) this.knownIps.add(p.ip);
    for (const a of attempts) {
      if (!a.private && Date.now() - a.last < DAY) this.recent.push({ ip: a.ip, name: a.names[0] || null, reason: a.reasons[0] || null, t: a.last });
    }
  }

  onLogLine(line) {
    if (!this.ready) return;
    const p = parseLine(line);
    const e = p && pickEvent(p);
    if (!e) return;
    if (e.type === 'ip') {
      this.knownIps.add(e.extra);
      this.recent = this.recent.filter((r) => r.ip !== e.extra);
      return;
    }
    if (e.type !== 'attempt' || !e.extra?.ip) return;
    const { ip, reason } = e.extra;
    if (this.knownIps.has(ip) || isPrivateIp(ip) || this.skip(e.name, reason)) return;
    const a = { ip, name: e.name || null, reason, t: Date.now() };
    this.recent.push(a);
    if (this.recent.length > 500) this.recent.splice(0, this.recent.length - 500);
    this.onAttempt(a);
  }

  // For /api/status: unknown public addresses seen in the last 24 h.
  summary() {
    const since = Date.now() - DAY;
    this.recent = this.recent.filter((r) => r.t >= since);
    const ips = new Set(this.recent.map((r) => r.ip));
    return { addresses: ips.size, attempts: this.recent.length, last: this.recent.length ? new Date(Math.max(...this.recent.map((r) => r.t))).toISOString() : null };
  }
}

module.exports = { Scanners };

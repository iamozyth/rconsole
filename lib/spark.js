'use strict';

// spark (https://spark.lucko.me) integration: start a profile or a health
// report over RCON and pick up the viewer link. spark runs its commands on
// its own threads, so the link rarely comes back in the RCON reply; it does
// land in spark's activity log (activity.json in its data folder), which
// rconsole can read.

const fs = require('fs');
const path = require('path');

const URL_RE = /https:\/\/spark\.lucko\.me\/[A-Za-z0-9]+/;
const DATA_DIRS = ['plugins/spark', 'config/spark'];

class Spark {
  constructor({ mcDir, rcon, plugins, commands = () => null, log = () => {} }) {
    Object.assign(this, { mcDir, rcon, plugins, commands, log });
    this.running = null; // { kind, startedAt, endsAt }
    this.lastLink = null;
  }

  activityFile() {
    for (const d of DATA_DIRS) {
      const f = path.join(this.mcDir, d, 'activity.json');
      if (fs.existsSync(f)) return f;
    }
    return null;
  }

  async installed() {
    if (DATA_DIRS.some((d) => fs.existsSync(path.join(this.mcDir, d)))) return true;
    if ((this.commands() || []).some((c) => c.name === 'spark')) return true;
    try {
      const { plugins } = await this.plugins.list();
      return plugins.some((p) => p.enabled !== false && /^spark$/i.test(p.name || ''));
    } catch {
      return false;
    }
  }

  // spark's activity log, newest first: { type, time, url, user }.
  activity(limit = 10) {
    const file = this.activityFile();
    if (!file) return [];
    try {
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      return (Array.isArray(list) ? list : [])
        .map((a) => ({ type: a.type || 'Activity', time: Number(a.time) || null, user: a.user?.name || null, url: a.data?.type === 'url' && URL_RE.test(a.data.value) ? a.data.value : null }))
        .filter((a) => a.url)
        .sort((a, b) => (b.time || 0) - (a.time || 0))
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  async status() {
    const installed = await this.installed();
    if (this.running && Date.now() > this.running.giveUpAt) this.running = null;
    return { installed, running: this.running, last: this.lastLink, activity: installed ? this.activity() : [] };
  }

  // kind: 'profile' (seconds) or 'health'. Resolves at once; the link is
  // collected in the background.
  async start(kind, seconds = 30) {
    if (this.running) throw Object.assign(new Error(`A spark ${this.running.kind} is already running`), { status: 409 });
    if (!(await this.installed())) throw Object.assign(new Error('spark is not installed'), { status: 409 });
    seconds = Math.min(300, Math.max(10, Math.round(Number(seconds) || 30)));
    const cmd = kind === 'health' ? 'spark health --upload' : `spark profiler start --timeout ${seconds}`;
    const startedAt = Date.now();
    const wait = kind === 'health' ? 5 : seconds + 5;
    this.running = { kind, startedAt, endsAt: startedAt + wait * 1000, giveUpAt: startedAt + (wait + 60) * 1000 };
    let reply = '';
    try {
      reply = await this.rcon.send(cmd);
    } catch (err) {
      this.running = null;
      throw err;
    }
    if (/unknown|not found|no permission/i.test(reply) && !/spark/i.test(reply.split('\n')[0] || '')) {
      this.running = null;
      throw Object.assign(new Error(`spark refused: ${reply.trim().slice(0, 200)}`), { status: 502 });
    }
    this.log(`spark: started ${kind}${kind === 'profile' ? ` for ${seconds}s` : ''}`);
    this.collect(startedAt, reply);
    return { running: this.running };
  }

  // Polls the activity log (and the reply) for the new link.
  collect(startedAt, reply) {
    const direct = reply.match(URL_RE)?.[0];
    const tick = () => {
      const found = direct || this.activity(5).find((a) => a.time && a.time >= startedAt - 2000)?.url;
      if (found) {
        this.lastLink = { kind: this.running?.kind || 'profile', url: found, at: Date.now() };
        this.log(`spark: ${found}`);
        this.running = null;
        return;
      }
      if (!this.running || Date.now() > this.running.giveUpAt) {
        this.running = null;
        return;
      }
      setTimeout(tick, 2000).unref?.();
    };
    setTimeout(tick, direct ? 0 : 2000).unref?.();
  }
}

module.exports = { Spark, URL_RE };

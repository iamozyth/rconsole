'use strict';

// Server jar updates for Paper and Folia (PaperMC API): find newer builds,
// then backup → swap jar → restart. Other platforms are detected and shown,
// but updated by hand.

const fs = require('fs');
const path = require('path');
const paper = require('./paper');

const CACHE_MS = 10 * 60 * 1000;

class Updates {
  constructor({ jobs, backups, countdown, mcDir, mcJar, log, platform }) {
    Object.assign(this, { jobs, backups, countdown, mcDir, mcJar, log, platform });
    this.cache = new Map();
    this.state = { running: false, step: null, target: null, startedAt: null, error: null, finishedAt: null, result: null };
    this.running = null;
  }

  async cached(key, fn) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = await fn();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  // From the startup lines of latest.log (see lib/platform.js); falls back
  // to the last update rconsole installed.
  async installed() {
    const pf = this.platform();
    if (pf.mcVersion) return { version: pf.mcVersion, build: pf.build, source: 'log', platform: pf.id, name: pf.name };
    const last = this.jobs.lastInstalled();
    return last ? { version: last.version, build: last.build, source: 'last update', platform: pf.id, name: pf.name } : null;
  }

  hasPrevious() {
    return fs.existsSync(path.join(this.mcDir, `${this.mcJar}.previous`));
  }

  async overview({ refresh = false } = {}) {
    if (refresh) this.cache.clear();
    const current = await this.installed();
    const pf = this.platform();
    const project = pf.updates;
    if (!project) {
      return { supported: false, platform: { id: pf.id, name: pf.name, loaderVersion: pf.loaderVersion }, current, newerBuilds: [], newerVersions: [], canRollback: this.hasPrevious(), error: null, state: this.state };
    }
    let builds = [];
    let versions = [];
    let error = null;
    try {
      versions = await this.cached(`${project}:versions`, () => paper.versions(project));
      if (current) builds = await this.cached(`${project}:builds:${current.version}`, () => paper.builds(current.version, project));
    } catch (err) {
      error = err.message;
    }
    const newerBuilds = current ? builds.filter((b) => b.id > current.build) : builds;
    const idx = current ? versions.indexOf(current.version) : -1;
    const newerVersions = idx > 0 ? versions.slice(0, idx) : [];
    if (!error) this.lastOverview = { newerBuilds, at: Date.now() };
    return {
      supported: true,
      platform: { id: pf.id, name: pf.name },
      current,
      newerBuilds: newerBuilds.slice(0, 20),
      newerVersions,
      canRollback: this.hasPrevious(),
      error,
      state: this.state,
    };
  }

  async builds(version) {
    if (!/^\d+(\.\d+)+$/.test(String(version))) throw Object.assign(new Error('Invalid version'), { status: 400 });
    const project = this.platform().updates;
    if (!project) throw Object.assign(new Error(`Automatic updates aren't available for ${this.platform().name}`), { status: 409 });
    return this.cached(`${project}:builds:${version}`, () => paper.builds(version, project));
  }

  // One update at a time. Progress is reported through `state`.
  start({ version, build, rollback = false, backup = true, restartSeconds = 60, user }) {
    if (this.running) throw Object.assign(new Error('An update is already running'), { status: 409 });
    if (!rollback && (!/^\d+(\.\d+)+$/.test(String(version)) || !Number.isInteger(build) || build < 1)) {
      throw Object.assign(new Error('Invalid version or build'), { status: 400 });
    }
    const seconds = Math.min(3600, Math.max(0, Math.round(Number(restartSeconds) || 0)));
    if (!rollback && !this.platform().updates) throw Object.assign(new Error(`Automatic updates aren't available for ${this.platform().name}`), { status: 409 });
    const target = rollback ? 'previous jar' : `${this.platform().name} ${version} #${build}`;
    this.state = { running: true, step: 'starting', target, startedAt: new Date().toISOString(), error: null, finishedAt: null, result: null };
    this.log(`update: ${user} started update to ${target}`);

    const step = (name) => {
      this.state.step = name;
      this.log(`update: ${name}`);
    };

    this.running = (async () => {
      if (backup && !rollback) {
        step('backing up world');
        await this.backups.run();
      }
      step(rollback ? 'restoring previous jar' : 'downloading and verifying jar');
      const result = await this.jobs.run('paper-update', rollback ? { rollback: true } : { version, build });
      this.state.result = result;
      step(`restarting in ${seconds}s`);
      await this.countdown.start(seconds, `update to ${target}`);
      step('done');
    })()
      .catch((err) => {
        this.state.error =
          this.state.result && /cancelled/i.test(err.message)
            ? 'Restart cancelled. The new jar is installed and takes effect at the next restart.'
            : err.message;
        this.log(`update: failed: ${err.message}`);
      })
      .finally(() => {
        this.state.running = false;
        this.state.finishedAt = new Date().toISOString();
        this.running = null;
        this.cache.clear();
      });

    return this.state;
  }
}

module.exports = { Updates };

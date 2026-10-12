'use strict';

// Server jar updates for Paper and Folia (PaperMC API): find newer builds and
// install one. The order keeps every player's progress: warn players
// (countdown) → disconnect everyone and stop the server → back up the world
// while nobody plays → swap the jar → start. Other platforms are detected and
// shown, but updated by hand.

const fs = require('fs');
const path = require('path');
const paper = require('./paper');

const CACHE_MS = 10 * 60 * 1000;

class Updates {
  constructor({ jobs, backups, countdown, mcDir, mcJar, log, platform, power = null, rcon = null }) {
    Object.assign(this, { jobs, backups, countdown, mcDir, mcJar, log, platform, power, rcon });
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

    const kick = async () => {
      if (!this.rcon) return;
      await this.rcon.send(`kick @a Updating the server to ${target}. Back in a minute!`).catch(() => {});
      await this.rcon.send('save-all flush').catch(() => {});
    };
    const swapJar = async () => {
      step(rollback ? 'restoring the previous jar' : 'downloading and verifying the new jar');
      this.state.result = await this.jobs.run('paper-update', rollback ? { rollback: true } : { version, build });
    };
    const backUp = async () => {
      if (!backup || rollback) return;
      step('backing up the world');
      await this.backups.run();
    };

    this.running = (async () => {
      const power = this.power ? await this.power.state().catch(() => ({ available: false })) : { available: false };
      const running = power.available ? power.active === 'active' : true;
      if (power.available && !running) {
        // Server is down: nothing to warn or stop.
        await backUp();
        await swapJar();
        step('done; takes effect when the server starts');
        return;
      }
      step(`warning players, stopping in ${seconds}s`);
      if (power.available) {
        await this.countdown.start(seconds, `update to ${target}`, { verb: 'restarting', finish: async () => { await kick(); await this.power.run('stop'); } });
        step('stopping the server');
        await this.power.waitFor(['inactive', 'failed']);
        try {
          await backUp();
          await swapJar();
        } finally {
          // Start again whatever happened, on the new jar or the old one.
          step('starting the server');
          await this.power.run('start');
        }
      } else {
        // No control over the service: back up with saving paused after
        // everyone is disconnected, then stop; systemd brings it back.
        await this.countdown.start(seconds, `update to ${target}`, { verb: 'restarting', finish: async () => {
          await kick();
          await backUp();
          await swapJar();
          step('restarting the server');
          await this.countdown.restart();
        } });
      }
      step('done');
    })()
      .catch((err) => {
        this.state.error = /cancelled/i.test(err.message) ? 'Update cancelled before the server stopped. Nothing was changed.' : err.message;
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

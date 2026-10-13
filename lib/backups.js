'use strict';

// World backups: pause autosave, flush, archive the world folders, resume
// autosave. The archive itself is made by the helper running as the Minecraft
// user, since Minecraft writes level.dat readable by its owner only.
// Files are <world>-<YYYY-MM-DD_HH-MM-SS>.tar.gz; retention is per world.

const fs = require('fs');
const path = require('path');
const names = require('./names');

class Backups {
  constructor({ rcon, jobs, backupDir, keep, log, activeWorld }) {
    Object.assign(this, { rcon, jobs, backupDir, keep, log, activeWorld });
    this.running = null; // Promise while a backup is in progress
    this.state = { running: false, world: null, startedAt: null, lastFile: null, lastError: null, lastFinishedAt: null };
  }

  isValidName(name) {
    return Boolean(names.parseBackupName(name));
  }

  filePath(name) {
    if (!this.isValidName(name)) throw Object.assign(new Error('Invalid backup name'), { status: 400 });
    return path.join(this.backupDir, name);
  }

  async list() {
    let entries;
    try {
      entries = await fs.promises.readdir(this.backupDir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const files = await Promise.all(
      entries.map(async (name) => {
        const parsed = names.parseBackupName(name);
        if (!parsed) return null;
        const s = await fs.promises.stat(path.join(this.backupDir, name));
        return { name, world: parsed.world, size: s.size, created: s.mtime.toISOString() };
      })
    );
    return files.filter(Boolean).sort((a, b) => b.created.localeCompare(a.created) || b.name.localeCompare(a.name));
  }

  async remove(name) {
    await fs.promises.unlink(this.filePath(name));
  }

  // Starts a backup of `world` (default: the active one); resolves with the
  // file name. Only one backup at a time.
  run(world) {
    if (this.running) return this.running;
    this.state = { ...this.state, running: true, world: world || null, startedAt: new Date().toISOString(), lastError: null };
    this.running = this.create(world)
      .then((name) => {
        this.state.lastFile = name;
        return name;
      })
      .catch((err) => {
        this.state.lastError = err.message;
        throw err;
      })
      .finally(() => {
        this.state.running = false;
        this.state.lastFinishedAt = new Date().toISOString();
        this.running = null;
      });
    return this.running;
  }

  async create(world) {
    const active = await this.activeWorld();
    world = world || active;
    if (!names.isWorldName(world)) throw Object.assign(new Error('Invalid world name'), { status: 400 });
    const stamp = names.timestamp();

    // Only the active world is being written to. If RCON is down the server is
    // most likely stopped, so files are consistent anyway.
    let paused = false;
    if (world === active) {
      try {
        await this.rcon.send('save-off');
        paused = true;
        await this.rcon.send('save-all flush');
      } catch (err) {
        this.log(`backup: RCON unavailable (${err.message}), backing up without pausing saves`);
      }
    }

    let result;
    try {
      result = await this.jobs.run('backup', { world, stamp });
    } finally {
      if (paused) await this.rcon.send('save-on').catch((err) => this.log(`backup: save-on failed: ${err.message}`));
    }

    await this.prune(world);
    this.log(`backup: created ${result.file}`);
    this.onCreated?.(result.file);
    return result.file;
  }

  async prune(world) {
    if (!this.keep) return;
    const files = (await this.list()).filter((f) => f.world === world);
    for (const { name } of files.slice(this.keep)) {
      await this.remove(name).catch(() => {});
      this.log(`backup: pruned ${name}`);
    }
  }
}

module.exports = { Backups };

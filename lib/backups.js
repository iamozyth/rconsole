'use strict';

// World backups: pause autosave, flush, archive the world folders, resume
// autosave. The archive itself is made by the helper running as the Minecraft
// user, since Minecraft writes level.dat readable by its owner only.

const fs = require('fs');
const path = require('path');

const NAME_RE = /^world-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.gz$/;

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

class Backups {
  constructor({ rcon, jobs, backupDir, keep, log }) {
    Object.assign(this, { rcon, jobs, backupDir, keep, log });
    this.running = null; // Promise while a backup is in progress
    this.state = { running: false, startedAt: null, lastFile: null, lastError: null, lastFinishedAt: null };
  }

  isValidName(name) {
    return NAME_RE.test(name);
  }

  filePath(name) {
    if (!this.isValidName(name)) throw Object.assign(new Error('Invalid backup name'), { status: 400 });
    return path.join(this.backupDir, name);
  }

  async list() {
    let names;
    try {
      names = await fs.promises.readdir(this.backupDir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const files = await Promise.all(
      names.filter((n) => NAME_RE.test(n)).map(async (name) => {
        const s = await fs.promises.stat(path.join(this.backupDir, name));
        return { name, size: s.size, created: s.mtime.toISOString() };
      })
    );
    return files.sort((a, b) => b.name.localeCompare(a.name));
  }

  async remove(name) {
    await fs.promises.unlink(this.filePath(name));
  }

  // Starts a backup; resolves with the file name when done. Only one at a time.
  run() {
    if (this.running) return this.running;
    this.state = { ...this.state, running: true, startedAt: new Date().toISOString(), lastError: null };
    this.running = this.create()
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

  async create() {
    const stamp = timestamp();

    // If RCON is down the server is most likely stopped, so files are consistent anyway.
    let paused = false;
    try {
      await this.rcon.send('save-off');
      paused = true;
      await this.rcon.send('save-all flush');
    } catch (err) {
      this.log(`backup: RCON unavailable (${err.message}), backing up without pausing saves`);
    }

    let result;
    try {
      result = await this.jobs.run('backup', stamp);
    } finally {
      if (paused) await this.rcon.send('save-on').catch((err) => this.log(`backup: save-on failed: ${err.message}`));
    }

    await this.prune();
    this.log(`backup: created ${result.file}`);
    return result.file;
  }

  async prune() {
    if (!this.keep) return;
    const files = await this.list();
    for (const { name } of files.slice(this.keep)) {
      await this.remove(name).catch(() => {});
      this.log(`backup: pruned ${name}`);
    }
  }
}

module.exports = { Backups };

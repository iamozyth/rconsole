'use strict';

// World backups: pause autosave, flush, tar the world folders, resume autosave.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { readProperties } = require('./access');

const NAME_RE = /^world-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.gz$/;

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function tar(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    // Exit code 1 means "some files changed while being read", which is fine
    // for region files Minecraft may still touch.
    child.on('close', (code) => (code <= 1 ? resolve() : reject(new Error(stderr.trim() || `tar exited with ${code}`))));
  });
}

class Backups {
  constructor({ rcon, mcDir, backupDir, keep, log }) {
    Object.assign(this, { rcon, mcDir, backupDir, keep, log });
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

  async worlds() {
    const level = (await readProperties(this.mcDir))['level-name'] || 'world';
    const candidates = [level, `${level}_nether`, `${level}_the_end`];
    const found = [];
    for (const dir of candidates) {
      try {
        if ((await fs.promises.stat(path.join(this.mcDir, dir))).isDirectory()) found.push(dir);
      } catch {}
    }
    if (!found.length) throw new Error(`No world folder "${level}" found in ${this.mcDir}`);
    return found;
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
    await fs.promises.mkdir(this.backupDir, { recursive: true });
    const worlds = await this.worlds();
    const name = `world-${timestamp()}.tar.gz`;
    const final = path.join(this.backupDir, name);
    const partial = `${final}.partial`;

    // If RCON is down the server is most likely stopped, so files are consistent anyway.
    let paused = false;
    try {
      await this.rcon.send('save-off');
      paused = true;
      await this.rcon.send('save-all flush');
    } catch (err) {
      this.log(`backup: RCON unavailable (${err.message}), backing up without pausing saves`);
    }

    try {
      await tar(['-czf', partial, '-C', this.mcDir, ...worlds]);
      await fs.promises.rename(partial, final);
    } catch (err) {
      await fs.promises.unlink(partial).catch(() => {});
      throw err;
    } finally {
      if (paused) await this.rcon.send('save-on').catch((err) => this.log(`backup: save-on failed: ${err.message}`));
    }

    await this.prune();
    this.log(`backup: created ${name}`);
    return name;
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

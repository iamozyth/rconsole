'use strict';

// Worlds: every folder in MC_DIR with a level.dat (plus its _nether and
// _the_end siblings). rconsole reads; switching, creating, deleting and
// restoring go through helper jobs and the ops tracker.

const fs = require('fs');
const path = require('path');
const names = require('./names');
const { readProperties } = require('./access');

const LEVEL_TYPES = { normal: 'minecraft:normal', flat: 'minecraft:flat', large_biomes: 'minecraft:large_biomes', amplified: 'minecraft:amplified' };
const httpError = (status, message) => Object.assign(new Error(message), { status });

async function dirSize(dir) {
  let total = 0;
  let stack = [dir];
  while (stack.length) {
    const batch = stack.splice(0, 32);
    const results = await Promise.all(
      batch.map(async (d) => {
        try {
          return { d, entries: await fs.promises.readdir(d, { withFileTypes: true }) };
        } catch {
          return { d, entries: [] };
        }
      })
    );
    for (const { d, entries } of results) {
      await Promise.all(
        entries.map(async (e) => {
          const p = path.join(d, e.name);
          if (e.isDirectory()) stack.push(p);
          else if (e.isFile()) total += (await fs.promises.stat(p).catch(() => ({ size: 0 }))).size;
        })
      );
    }
  }
  return total;
}

class Worlds {
  constructor({ mcDir, stateDir, jobs, backups, power, countdown, ops, rcon, log }) {
    Object.assign(this, { mcDir, jobs, backups, power, countdown, ops, rcon, log });
    this.metaFile = path.join(stateDir, 'worlds.json');
    this.sizeCache = new Map();
  }

  async active() {
    return (await readProperties(this.mcDir))['level-name'] || 'world';
  }

  meta() {
    try {
      return JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
    } catch {
      return {};
    }
  }

  saveMeta(meta) {
    fs.mkdirSync(path.dirname(this.metaFile), { recursive: true });
    fs.writeFileSync(`${this.metaFile}.tmp`, JSON.stringify(meta, null, 2));
    fs.renameSync(`${this.metaFile}.tmp`, this.metaFile);
  }

  async size(name) {
    const hit = this.sizeCache.get(name);
    if (hit && Date.now() - hit.at < 60000) return hit.size;
    let size = 0;
    for (const d of names.DIMENSIONS) size += await dirSize(path.join(this.mcDir, name + d));
    this.sizeCache.set(name, { at: Date.now(), size });
    return size;
  }

  async list() {
    const active = await this.active();
    const meta = this.meta();
    const entries = await fs.promises.readdir(this.mcDir, { withFileTypes: true });
    const found = new Set();
    for (const e of entries) {
      if (!e.isDirectory() || !names.isWorldName(e.name)) continue;
      if (fs.existsSync(path.join(this.mcDir, e.name, 'level.dat'))) found.add(e.name);
    }
    if (names.isWorldName(active)) found.add(active); // configured but not generated yet
    const worlds = await Promise.all(
      [...found].map(async (name) => {
        const levelDat = path.join(this.mcDir, name, 'level.dat');
        const stat = await fs.promises.stat(levelDat).catch(() => null);
        return {
          name,
          active: name === active,
          generated: Boolean(stat),
          // Bukkit servers keep nether/end next to the world (world_nether),
          // vanilla, Fabric and Forge inside it (world/DIM-1, world/DIM1).
          dimensions: [...new Set([
            ...names.DIMENSIONS.filter((d) => fs.existsSync(path.join(this.mcDir, name + d))).map((d) => d.slice(1) || 'overworld'),
            ...[['DIM-1', 'nether'], ['DIM1', 'the_end']].filter(([d]) => fs.existsSync(path.join(this.mcDir, name, d))).map(([, label]) => label),
          ])],
          lastPlayed: stat ? stat.mtime.toISOString() : null,
          size: stat ? await this.size(name) : 0,
          seed: meta[name]?.seed ?? null,
          type: meta[name]?.type ?? null,
          created: meta[name]?.created ?? null,
        };
      })
    );
    return { active, worlds: worlds.sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name)) };
  }

  async exists(name) {
    return names.DIMENSIONS.some((d) => fs.existsSync(path.join(this.mcDir, name + d)));
  }

  // Restarts after a properties change, with the usual countdown when the
  // server is up; when it is stopped the change simply applies at next start.
  async restartIfRunning(step, seconds, reason) {
    const st = await this.power.state();
    if (st.available && st.active !== 'active') return 'applies at next start';
    step(`restarting in ${seconds}s`);
    await this.countdown.start(seconds, reason);
    return 'restarted';
  }

  activate(name, { seconds = 60, user }) {
    if (!names.isWorldName(name)) throw httpError(400, 'Invalid world name');
    return this.ops.start(`Switch to world ${name}`, user, async (step) => {
      if (name === (await this.active())) throw new Error(`${name} is already the active world`);
      if (!(await this.exists(name))) throw new Error(`World ${name} not found`);
      step('setting level-name');
      await this.jobs.run('properties', { world: true, set: { 'level-name': name } });
      return { world: name, restart: await this.restartIfRunning(step, seconds, `switch to ${name}`) };
    });
  }

  create({ name, seed = '', type = 'normal', activate = true, seconds = 60, user }) {
    if (!names.isWorldName(name)) throw httpError(400, 'World names use letters, digits, - and _ (max 32), and can’t end in _nether or _the_end');
    if (!LEVEL_TYPES[type]) throw httpError(400, `Type must be one of ${Object.keys(LEVEL_TYPES).join(', ')}`);
    seed = String(seed ?? '').trim();
    if (seed.length > 64 || /[\r\n]/.test(seed)) throw httpError(400, 'Seeds are limited to 64 characters');
    return this.ops.start(`Create world ${name}`, user, async (step) => {
      if (await this.exists(name)) throw new Error(`A world named ${name} already exists`);
      const meta = this.meta();
      meta[name] = { seed: seed || null, type, created: new Date().toISOString(), createdBy: user };
      this.saveMeta(meta);
      if (!activate) return { world: name, note: 'saved; generated when first activated' };
      step('setting world properties');
      await this.jobs.run('properties', { world: true, set: { 'level-name': name, 'level-seed': seed, 'level-type': LEVEL_TYPES[type] } });
      return { world: name, restart: await this.restartIfRunning(step, seconds, `new world ${name}`) };
    });
  }

  remove(name, { archive = true, user }) {
    if (!names.isWorldName(name)) throw httpError(400, 'Invalid world name');
    return this.ops.start(`Delete world ${name}`, user, async (step) => {
      if (name === (await this.active())) throw new Error('Switch to another world before deleting this one');
      step(archive ? 'archiving and deleting' : 'deleting');
      const result = await this.jobs.run('world-delete', { world: name, archive });
      const meta = this.meta();
      delete meta[name];
      this.saveMeta(meta);
      this.sizeCache.delete(name);
      return result;
    });
  }

  // mode "new": extract as a new world next to the others, no downtime.
  // mode "replace": overwrite `target` (default: the backup's own world). For
  // the active world: countdown, stop, safety backup, restore, start.
  restore(file, { mode = 'replace', target, seconds = 60, user }) {
    const parsed = names.parseBackupName(file);
    if (!parsed) throw httpError(400, 'Invalid backup name');
    target = target || parsed.world;
    if (!names.isWorldName(target)) throw httpError(400, 'Invalid world name');
    return this.ops.start(`Restore ${file}${mode === 'new' ? ` as ${target}` : ''}`, user, async (step) => {
      if (mode === 'new') {
        if (await this.exists(target)) throw new Error(`A world named ${target} already exists`);
        step('extracting');
        return this.jobs.run('restore', { file, target, replace: false });
      }
      const isActive = target === (await this.active());
      let wasRunning = false;
      if (isActive) {
        const st = await this.power.state();
        if (!st.available) throw new Error('Restoring the active world needs control of the server service (see README: polkit rule)');
        wasRunning = st.active === 'active';
        if (wasRunning) {
          step(`stopping in ${seconds}s`);
          await this.countdown.start(seconds, `restore ${file}`, { verb: 'stopping', finish: () => this.power.run('stop') });
          await this.power.waitFor(['inactive', 'failed']);
        }
      }
      if (await this.exists(target)) {
        step('safety backup of the current world');
        await this.backups.run(target);
      }
      step('restoring');
      const result = await this.jobs.run('restore', { file, target, replace: true });
      this.sizeCache.delete(target);
      if (wasRunning) {
        step('starting the server');
        await this.power.run('start');
      }
      return result;
    });
  }
}

module.exports = { Worlds, LEVEL_TYPES };

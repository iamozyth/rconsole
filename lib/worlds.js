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

// Bytes under `dir`. Folders that can't be read (permissions) are counted
// in `unreadable` instead of silently as 0; a missing `dir` is just 0.
async function dirSize(dir) {
  let total = 0;
  let unreadable = 0;
  let stack = [dir];
  while (stack.length) {
    const batch = stack.splice(0, 32);
    const results = await Promise.all(
      batch.map(async (d) => {
        try {
          return { d, entries: await fs.promises.readdir(d, { withFileTypes: true }) };
        } catch (err) {
          if (err.code !== 'ENOENT') unreadable++;
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
  return { size: total, unreadable };
}

// The dimensions saved in a world, wherever this version keeps them:
// Bukkit next to it (world_nether, world_the_end), vanilla up to 1.21
// inside it (DIM-1, DIM1), and 26.x under dimensions/<namespace>/<name>.
const DIM_LABEL = { overworld: 'overworld', the_nether: 'nether', 'DIM-1': 'nether', the_end: 'the_end', DIM1: 'the_end' };
function dimensionsOf(mcDir, name) {
  const found = new Set();
  const has = (...p) => fs.existsSync(path.join(mcDir, ...p));
  if (has(name, 'region') || has(name, 'level.dat')) found.add('overworld');
  for (const d of names.DIMENSIONS.slice(1)) if (has(name + d)) found.add(d === '_nether' ? 'nether' : 'the_end');
  for (const d of ['DIM-1', 'DIM1']) if (has(name, d)) found.add(DIM_LABEL[d]);
  let spaces = [];
  try {
    spaces = fs.readdirSync(path.join(mcDir, name, 'dimensions'), { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {}
  for (const ns of spaces) {
    let dims = [];
    try {
      dims = fs.readdirSync(path.join(mcDir, name, 'dimensions', ns.name), { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {}
    for (const d of dims) found.add(ns.name === 'minecraft' ? DIM_LABEL[d.name] || d.name : `${ns.name}:${d.name}`);
  }
  const order = ['overworld', 'nether', 'the_end'];
  return [...found].sort((a, b) => (order.indexOf(a) + 1 || 9) - (order.indexOf(b) + 1 || 9) || a.localeCompare(b));
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
    let unreadable = 0;
    for (const d of names.DIMENSIONS) {
      const r = await dirSize(path.join(this.mcDir, name + d));
      size += r.size;
      unreadable += r.unreadable;
    }
    if (unreadable && !this.sizeCache.get(name)?.unreadable) this.log?.(`worlds: ${unreadable} folder(s) of ${name} can't be read by rconsole; its size is too small`);
    this.sizeCache.set(name, { at: Date.now(), size, unreadable });
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
          dimensions: dimensionsOf(this.mcDir, name),
          lastPlayed: stat ? stat.mtime.toISOString() : null,
          size: stat ? await this.size(name) : 0,
          sizeIncomplete: Boolean(this.sizeCache.get(name)?.unreadable),
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

module.exports = { dirSize, dimensionsOf, Worlds, LEVEL_TYPES };

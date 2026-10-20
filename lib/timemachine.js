'use strict';

// Time machine for players: what a player carried at each backup, what is
// missing now, and putting it back. Backups are whole-world archives, so the
// player files are taken out of each one once (tar with a wildcard, no
// region files written) and kept in STATE_DIR/timemachine/<backup>/ until
// the backup is deleted. Restoring goes through the helper job
// player-restore (bin/mc-helper.js), which writes as the Minecraft user.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const nbt = require('./nbt');
const names = require('./names');
const { items } = require('./playerinfo');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PLAYERS = 20000;
const bad = (status, msg) => Object.assign(new Error(msg), { status });

function tar(args, { timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    // 2 with "Not found in archive": a backup without player files.
    child.on('close', (code) => (code === 0 || (code === 2 && /not found in archive/i.test(err)) ? resolve() : reject(new Error(err.trim().split('\n').pop() || `tar exited with ${code}`))));
  });
}

// One entry per stack: id, custom name and enchanted, counted.
function tally(list) {
  const out = new Map();
  for (const x of list) {
    if (!x) continue;
    const key = `${x.id}\u0000${x.name || ''}\u0000${x.enchanted ? 1 : 0}`;
    const e = out.get(key) || { id: x.id, name: x.name || null, enchanted: x.enchanted, count: 0 };
    e.count += x.count || 1;
    out.set(key, e);
  }
  return out;
}

// What the player had then and doesn't have now (and the other way round).
function diff(then, now) {
  const a = tally(then);
  const b = tally(now);
  const missing = [];
  const gained = [];
  for (const [k, e] of a) {
    const n = b.get(k)?.count || 0;
    if (e.count > n) missing.push({ ...e, count: e.count - n });
  }
  for (const [k, e] of b) {
    const n = a.get(k)?.count || 0;
    if (e.count > n) gained.push({ ...e, count: e.count - n });
  }
  const byCount = (x, y) => y.count - x.count || x.id.localeCompare(y.id);
  return { missing: missing.sort(byCount), gained: gained.sort(byCount) };
}

const flat = (inv) => (inv ? [...inv.hotbar, ...inv.inventory, ...Object.values(inv.gear)] : []);
function itemOf(x) {
  return items([{ ...x, Slot: 0 }]).hotbar[0];
}

// Reads a player file into what the UI shows.
function readState(buf) {
  const root = nbt.read(buf);
  return {
    ...items(root.Inventory, root.equipment),
    selected: typeof root.SelectedItemSlot === 'number' ? root.SelectedItemSlot : null,
    ender: Array.from({ length: 27 }, (_, i) => {
      const x = Array.isArray(root.EnderItems) ? root.EnderItems.find((e) => e?.Slot === i) : null;
      return x ? itemOf(x) : null;
    }),
    xp: typeof root.XpLevel === 'number' ? root.XpLevel : null,
    health: typeof root.Health === 'number' ? Math.round(root.Health * 10) / 10 : null,
    dimension: typeof root.Dimension === 'string' ? root.Dimension.replace(/^minecraft:/, '') : null,
    pos: Array.isArray(root.Pos) ? root.Pos.map((v) => Math.round(v)) : null,
  };
}

class TimeMachine {
  constructor({ backups, backupDir, stateDir, jobs, playerInfo, activeWorld, log = () => {} }) {
    Object.assign(this, { backups, backupDir, jobs, playerInfo, activeWorld, log });
    this.cacheDir = path.join(stateDir, 'timemachine');
    this.indexing = new Map(); // backup -> Promise
    this.queue = Promise.resolve();
  }

  cachePath(backup) {
    if (!names.parseBackupName(backup)) throw bad(400, 'Invalid backup name');
    return path.join(this.cacheDir, backup);
  }

  indexed(backup) {
    return fs.existsSync(path.join(this.cachePath(backup), '.done'));
  }

  // Removes the copies of backups that were deleted or pruned.
  async prune(present) {
    let dirs = [];
    try {
      dirs = await fs.promises.readdir(this.cacheDir);
    } catch {
      return;
    }
    for (const d of dirs) if (!present.has(d) && !this.indexing.has(d)) await fs.promises.rm(path.join(this.cacheDir, d), { recursive: true, force: true });
  }

  // Takes the player files out of one backup; one backup at a time, since
  // each run decompresses the whole archive.
  index(backup) {
    const dir = this.cachePath(backup);
    if (this.indexed(backup)) return Promise.resolve();
    if (this.indexing.has(backup)) return this.indexing.get(backup);
    const run = (this.queue = this.queue.catch(() => {}).then(() => this.extract(backup, dir)));
    this.indexing.set(backup, run);
    run.finally(() => this.indexing.delete(backup)).catch(() => {});
    return run;
  }

  async extract(backup, dir) {
    const { world, compression } = names.parseBackupName(backup);
    const tmp = `${dir}.tmp`;
    await fs.promises.rm(tmp, { recursive: true, force: true });
    await fs.promises.mkdir(tmp, { recursive: true, mode: 0o700 });
    const started = Date.now();
    try {
      await tar([
        '-x', compression === 'zst' ? '--zstd' : '-z', '-f', path.join(this.backupDir, backup), '-C', tmp,
        '--no-same-owner', '--no-same-permissions', '--wildcards',
        '--', `${world}/players/data/*.dat`, `${world}/playerdata/*.dat`,
      ]);
      let n = 0;
      for (const sub of ['players/data', 'playerdata']) {
        let files = [];
        try {
          files = await fs.promises.readdir(path.join(tmp, world, sub));
        } catch {
          continue;
        }
        for (const f of files) {
          const m = f.match(/^([0-9a-f-]{36})\.dat$/);
          const src = path.join(tmp, world, sub, f);
          if (!m || !UUID_RE.test(m[1]) || !(await fs.promises.lstat(src)).isFile() || ++n > MAX_PLAYERS) continue;
          await fs.promises.rename(src, path.join(tmp, `${m[1]}.dat`));
        }
      }
      await fs.promises.rm(path.join(tmp, world), { recursive: true, force: true });
      await fs.promises.writeFile(path.join(tmp, '.done'), JSON.stringify({ players: n, at: new Date().toISOString(), ms: Date.now() - started }));
      await fs.promises.rm(dir, { recursive: true, force: true });
      await fs.promises.rename(tmp, dir);
      this.log(`timemachine: ${backup}: ${n} player file${n === 1 ? '' : 's'} in ${Math.round((Date.now() - started) / 100) / 10} s`);
    } catch (err) {
      await fs.promises.rm(tmp, { recursive: true, force: true });
      throw Object.assign(new Error(`Can't read ${backup}: ${err.message}`), { status: 500 });
    }
  }

  // Earlier states this player can go back to: the backups of the world the
  // server plays, newest first, and the copies earlier restores kept.
  async list(uuid) {
    if (!UUID_RE.test(String(uuid))) throw bad(400, 'Invalid player id');
    const world = await this.activeWorld();
    const all = await this.backups.list();
    await this.prune(new Set(all.map((b) => b.name)));
    const backups = all.filter((b) => b.world === world).map((b) => ({
      name: b.name,
      created: b.created,
      size: b.size,
      indexed: this.indexed(b.name),
      indexing: this.indexing.has(b.name),
      has: this.indexed(b.name) ? fs.existsSync(path.join(this.cachePath(b.name), `${uuid}.dat`)) : null,
    }));
    return { world, backups, undo: this.undoList(world, uuid) };
  }

  undoList(world, uuid) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(this.backupDir, '.player-restores', world));
    } catch {}
    return files.map((f) => f.startsWith(`${uuid}-`) && f.slice(37, -4)).filter((s) => s && names.STAMP_RE.test(s)).sort().reverse().slice(0, 5)
      .map((stamp) => ({ stamp, at: stampDate(stamp) }));
  }

  // The player at one backup, next to what they have now.
  async at(uuid, backup, { name } = {}) {
    if (!UUID_RE.test(String(uuid))) throw bad(400, 'Invalid player id');
    const world = await this.activeWorld();
    const b = names.parseBackupName(backup);
    if (!b) throw bad(400, 'Invalid backup name');
    if (b.world !== world) throw bad(400, `${backup} is a backup of ${b.world}`);
    if (!fs.existsSync(path.join(this.backupDir, backup))) throw bad(404, 'Backup not found');
    await this.index(backup);
    let buf;
    try {
      buf = await fs.promises.readFile(path.join(this.cachePath(backup), `${uuid}.dat`));
    } catch {
      return { backup, found: false };
    }
    const then = readState(buf);
    const now = await this.current(uuid, name);
    return {
      backup,
      found: true,
      then,
      now: now ? { online: now.online, from: now.from } : null,
      inventory: now ? diff(flat(then), flat(now.state)) : null,
      enderChest: now?.state.ender ? diff(then.ender, now.state.ender) : null,
    };
  }

  // Now: live when online (the inventory; the ender chest only as last
  // saved), else the player's file.
  async current(uuid, name) {
    const f = this.playerInfo.playerFile('data', uuid, 'dat');
    let saved = null;
    try {
      if (f) saved = readState(fs.readFileSync(f));
    } catch {}
    const live = name ? await this.playerInfo.live(name).catch(() => null) : null;
    if (live && live.uuid === uuid && live.inventoryRead) return { online: true, from: 'live', state: { hotbar: live.hotbar, inventory: live.inventory, gear: live.gear, ender: saved?.ender || null } };
    if (saved) return { online: Boolean(live), from: 'saved', state: saved };
    return null;
  }

  restore(uuid, { backup, undo, parts }) {
    if (!UUID_RE.test(String(uuid))) throw bad(400, 'Invalid player id');
    const p = (Array.isArray(parts) ? parts : []).filter((x) => x === 'inventory' || x === 'ender');
    if (!p.length) throw bad(400, 'Choose the inventory, the ender chest or both');
    if (undo !== undefined && !names.STAMP_RE.test(String(undo))) throw bad(400, 'Invalid restore');
    if (undo === undefined && !names.parseBackupName(backup)) throw bad(400, 'Invalid backup name');
    return this.jobs.run('player-restore', undo !== undefined ? { uuid, undo, parts: p } : { uuid, backup, parts: p });
  }
}

function stampDate(stamp) {
  const m = stamp.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
  return m ? new Date(m[1], m[2] - 1, m[3], m[4], m[5], m[6]).toISOString() : null;
}

module.exports = { TimeMachine, diff, readState };

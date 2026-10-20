'use strict';

// Time machine for the world: compare an area with a backup chunk by chunk
// (blocks, and chest or sign contents), then put the chunks you pick back.
// Comparing reads the region files the area needs out of the backup once
// (STATE_DIR/area/<backup>/, only the newest backup asked for is kept) and
// the world's own files as they are on disk. Restoring stops the server,
// runs the helper job area-restore and starts it again.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const names = require('./names');
const region = require('./region');
const nbtedit = require('./nbtedit');

const MAX_CHUNKS = 1024;
const LIMIT = 30000000;
const bad = (status, msg) => Object.assign(new Error(msg), { status });

// Block entities that change on their own (spawners, vaults, sculk, bees)
// and fields that do (furnaces burning): not a change anyone made.
const RESTLESS = new Set(['vault', 'trial_spawner', 'spawner', 'mob_spawner', 'sculk_sensor', 'calibrated_sculk_sensor', 'sculk_catalyst', 'sculk_shrieker', 'bell', 'conduit', 'beehive', 'bee_nest', 'creaking_heart', 'end_gateway', 'daylight_detector', 'comparator'].map((n) => `minecraft:${n}`));
const VOLATILE = new Set(['cooking_time_spent', 'cooking_total_time', 'lit_time_remaining', 'lit_total_time', 'BurnTime', 'CookTime', 'CookTimeTotal', 'Delay', 'TransferCooldown', 'ticks_since_song', 'Age', 'keepPacked']);

function tar(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30 * 60 * 1000 });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 || (code === 2 && /not found in archive/i.test(err)) ? resolve() : reject(new Error(err.trim().split('\n').pop() || `tar exited with ${code}`))));
  });
}

const str = (t) => (t?.type === 8 ? t.raw.toString('utf8') : null);
const num = (t) => (t?.type === 3 ? t.raw.readInt32BE(0) : t?.type === 1 ? t.raw.readInt8(0) : null);

// A palette entry as text. 26.x writes a bare id (a string, or in a mixed
// list a compound holding it under ""), or { id, properties }; before
// that { Name, Properties }.
function blockName(t) {
  if (t.type === 8) return t.raw.toString('utf8');
  const name = str(nbtedit.get(t, '')) || str(nbtedit.get(t, 'id')) || str(nbtedit.get(t, 'Name')) || '?';
  const props = nbtedit.get(t, 'properties') || nbtedit.get(t, 'Properties');
  return props?.entries?.length ? `${name}[${props.entries.map(([k, v]) => `${k}=${str(v)}`).join(',')}]` : name;
}

// The 4096 blocks of a section (y, z, x order), or one name when it is all
// the same block. Indices are packed into longs, at least 4 bits each, and
// (since 1.16) never split across two longs.
function sectionBlocks(states, map = (n) => n) {
  const palette = (nbtedit.get(states, 'palette')?.items || []).map((t) => map(blockName(t)));
  const data = nbtedit.get(states, 'data');
  if (!data || palette.length <= 1) return palette[0] || 'minecraft:air';
  const raw = data.raw.subarray(4);
  const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
  const per = Math.floor(64 / bits);
  if (raw.length < Math.ceil(4096 / per) * 8) throw new Error('short block data');
  const mask = (1 << bits) - 1;
  const out = new Array(4096);
  for (let w = 0, i = 0; i < 4096; w++) {
    // Two 32-bit halves: bits never exceed 32 per index here.
    const hi = raw.readUInt32BE(w * 8);
    const lo = raw.readUInt32BE(w * 8 + 4);
    for (let k = 0; k < per && i < 4096; k++, i++) {
      const shift = k * bits;
      let v;
      if (shift + bits <= 32) v = (lo >>> shift) & mask;
      else if (shift >= 32) v = (hi >>> (shift - 32)) & mask;
      else v = ((lo >>> shift) | (hi << (32 - shift))) & mask;
      out[i] = palette[v] ?? '?';
    }
  }
  return out;
}

// What grows, spreads, burns, melts or pops off by itself, so a world that
// was only played in doesn't look changed: these count as air, or as the
// block they turn into.
const AS_AIR = new Set(['cave_air', 'void_air', 'fire', 'soul_fire', 'snow', 'vine', 'cave_vines', 'cave_vines_plant', 'kelp', 'kelp_plant', 'sugar_cane', 'bamboo', 'bamboo_sapling', 'cactus', 'brown_mushroom', 'red_mushroom', 'short_grass', 'tall_grass', 'glow_lichen', 'pointed_dripstone', 'sweet_berry_bush', 'twisting_vines', 'twisting_vines_plant', 'weeping_vines', 'weeping_vines_plant'].map((n) => `minecraft:${n}`));
const AS = { grass_block: 'dirt', mycelium: 'dirt', podzol: 'dirt', farmland: 'dirt', dirt_path: 'dirt', ice: 'water', frosted_ice: 'water', bubble_column: 'water', obsidian: 'lava', cobblestone: 'lava' };

// Blocks as a player sees them changed: the id without its state (leaves
// count their distance to a log, doors open and close), flowing water and
// lava like air (only a source block is placed).
function plain(name) {
  let id = name.replace(/\[.*$/, '');
  if (AS_AIR.has(id)) return 'minecraft:air';
  const short = id.startsWith('minecraft:') ? id.slice(10) : null;
  if (short && Object.hasOwn(AS, short)) id = `minecraft:${AS[short]}`;
  if ((id === 'minecraft:water' || id === 'minecraft:lava') && /[[,]level=(?!0[\],])/.test(name)) return 'minecraft:air';
  return id;
}

// What a chunk holds that people change: blocks per section (Y -> states
// tag, decoded only when two differ), block entities by position. Handles
// 1.18+ (sections/block_states); older chunks compare by bytes.
function fingerprint(buf) {
  const { root } = nbtedit.parse(buf);
  const level = nbtedit.get(root, 'Level');
  const top = level?.type === 10 ? level : root;
  const sections = new Map();
  const secs = nbtedit.get(top, 'sections') || nbtedit.get(top, 'Sections');
  for (const s of secs?.items || []) {
    if (s.type !== 10) continue;
    const y = num(nbtedit.get(s, 'Y'));
    const states = nbtedit.get(s, 'block_states');
    if (states) sections.set(y, { states, key: nbtedit.bytes(states).toString('base64') });
    else {
      const old = [nbtedit.get(s, 'Palette'), nbtedit.get(s, 'BlockStates')].filter(Boolean);
      if (old.length) sections.set(y, { key: old.map((p) => nbtedit.bytes(p).toString('base64')).join('|') });
    }
  }
  const entities = new Map();
  const list = nbtedit.get(top, 'block_entities') || nbtedit.get(top, 'TileEntities');
  for (const e of list?.items || []) {
    if (e.type !== 10 || RESTLESS.has(str(nbtedit.get(e, 'id')))) continue;
    const pos = ['x', 'y', 'z'].map((k) => num(nbtedit.get(e, k))).join(',');
    const kept = { type: 10, entries: e.entries.filter(([k]) => !VOLATILE.has(k)) };
    entities.set(pos, nbtedit.bytes(kept).toString('base64'));
  }
  return { sections, entities };
}

// How many blocks differ between two sections (either may be missing: air).
function changedBlocks(a, b) {
  if (a?.key === b?.key) return 0;
  if ((a && !a.states) || (b && !b.states)) return 4096; // pre-1.18: count the section
  const x = a ? sectionBlocks(a.states, plain) : 'minecraft:air';
  const y = b ? sectionBlocks(b.states, plain) : 'minecraft:air';
  if (typeof x === 'string' && typeof y === 'string') return x === y ? 0 : 4096;
  let n = 0;
  for (let i = 0; i < 4096; i++) if ((typeof x === 'string' ? x : x[i]) !== (typeof y === 'string' ? y : y[i])) n++;
  return n;
}

// One chunk then against now -> [kind, changed blocks, changed block
// entities]: '.' same, 'b' blocks changed, 'c' only contents (chests,
// signs) changed, 'n' new since the backup, 'g' gone now, '-' in neither.
function compareChunk(then, now) {
  if (!then && !now) return ['-', 0, 0];
  if (!then) return ['n', 0, 0];
  if (!now) return ['g', 0, 0];
  if (then.data.equals(now.data)) return ['.', 0, 0];
  let a;
  let b;
  try {
    const ra = region.inflate(then);
    const rb = region.inflate(now);
    if (!ra || !rb) return ['b', 0, 0];
    a = fingerprint(ra);
    b = fingerprint(rb);
  } catch {
    return ['b', 0, 0];
  }
  let blocks = 0;
  try {
    for (const y of new Set([...a.sections.keys(), ...b.sections.keys()])) blocks += changedBlocks(a.sections.get(y), b.sections.get(y));
  } catch {
    blocks = 1;
  }
  let contents = 0;
  for (const k of new Set([...a.entities.keys(), ...b.entities.keys()])) if (a.entities.get(k) !== b.entities.get(k)) contents++;
  return [blocks ? 'b' : contents ? 'c' : '.', blocks, contents];
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

class AreaRestore {
  constructor({ mcDir, backupDir, stateDir, backups, jobs, power, countdown, ops, activeWorld, log = () => {} }) {
    Object.assign(this, { mcDir, backupDir, backups, jobs, power, countdown, ops, activeWorld, log });
    this.cacheDir = path.join(stateDir, 'area');
    this.extracting = new Map(); // key -> Promise
    this.queue = Promise.resolve();
  }

  // Block corners -> the chunks, checked against the limits.
  area(q) {
    const c = ['x1', 'z1', 'x2', 'z2'].map((k) => Number(q[k]));
    if (!c.every((n) => Number.isInteger(n) && Math.abs(n) <= LIMIT)) throw bad(400, 'Give the corners as whole block coordinates');
    const [x1, z1, x2, z2] = c;
    const w = region.chunkOf(Math.max(x1, x2)) - region.chunkOf(Math.min(x1, x2)) + 1;
    const h = region.chunkOf(Math.max(z1, z2)) - region.chunkOf(Math.min(z1, z2)) + 1;
    if (w * h > MAX_CHUNKS) throw bad(400, `That is ${w * h} chunks; at most ${MAX_CHUNKS} (512 × 512 blocks) at a time`);
    return { x1, z1, x2, z2, cx: region.chunkOf(Math.min(x1, x2)), cz: region.chunkOf(Math.min(z1, z2)), w, h };
  }

  async checkBackup(backup) {
    const b = names.parseBackupName(String(backup || ''));
    if (!b) throw bad(400, 'Invalid backup name');
    const world = await this.activeWorld();
    if (b.world !== world) throw bad(400, `${backup} is a backup of ${b.world}, the server plays ${world}`);
    if (!fs.existsSync(path.join(this.backupDir, backup))) throw bad(404, 'Backup not found');
    return { ...b, world };
  }

  checkDimension(d) {
    if (!region.DIMENSIONS.includes(d)) throw bad(400, 'Invalid dimension');
    return d;
  }

  regionDir(backup, dimension) {
    return path.join(this.cacheDir, backup, dimension);
  }

  haveFile(backup, dimension) {
    return path.join(this.regionDir(backup, dimension), '.have.json');
  }

  have(backup, dimension) {
    try {
      return new Set(JSON.parse(fs.readFileSync(this.haveFile(backup, dimension), 'utf8')));
    } catch {
      return new Set();
    }
  }

  // Whether the region files of an area are out of the backup yet.
  ready(backup, dimension, keys) {
    const have = this.have(backup, dimension);
    return keys.every((k) => have.has(k));
  }

  // Takes the missing region files of an area out of a backup. One run at a
  // time: each decompresses the whole archive.
  prepare(backup, dimension, keys) {
    const id = `${backup}|${dimension}|${keys.join(';')}`;
    if (this.extracting.has(id)) return this.extracting.get(id);
    const run = (this.queue = this.queue.catch(() => {}).then(() => this.extract(backup, dimension, keys)));
    this.extracting.set(id, run);
    run.finally(() => this.extracting.delete(id)).catch(() => {});
    return run;
  }

  preparing(backup) {
    return [...this.extracting.keys()].some((k) => k.startsWith(`${backup}|`));
  }

  async extract(backup, dimension, keys) {
    const have = this.have(backup, dimension);
    const missing = keys.filter((k) => !have.has(k));
    if (!missing.length) return;
    // Only the newest backup asked for stays: region files are big.
    let dirs = [];
    try {
      dirs = await fs.promises.readdir(this.cacheDir);
    } catch {}
    for (const d of dirs) if (d !== backup) await fs.promises.rm(path.join(this.cacheDir, d), { recursive: true, force: true });
    const { world, compression } = names.parseBackupName(backup);
    const dir = this.regionDir(backup, dimension);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const started = Date.now();
    try {
      await tar(['-x', compression === 'zst' ? '--zstd' : '-z', '-f', path.join(this.backupDir, backup), '-C', dir, '--no-same-owner', '--no-same-permissions', '--wildcards', '--', ...region.members(world, dimension, missing, ['region'])]);
    } catch (err) {
      throw Object.assign(new Error(`Can't read ${backup}: ${err.message}`), { status: 500 });
    }
    for (const k of missing) have.add(k);
    await fs.promises.writeFile(this.haveFile(backup, dimension), JSON.stringify([...have]));
    this.log(`area: ${backup} ${dimension}: ${missing.length} region${missing.length === 1 ? '' : 's'} in ${Math.round((Date.now() - started) / 100) / 10} s`);
  }

  // The area then and now, chunk by chunk. { preparing: true } while the
  // backup is being read.
  async compare({ backup, dimension, ...q }) {
    const b = await this.checkBackup(backup);
    dimension = this.checkDimension(dimension);
    const a = this.area(q);
    const chunks = region.chunksIn(a);
    const groups = region.byRegion(chunks);
    const keys = [...groups.keys()];
    if (!this.ready(backup, dimension, keys)) {
      this.prepare(backup, dimension, keys).catch((err) => this.log(`area: ${err.message}`));
      return { preparing: true };
    }
    const base = this.regionDir(backup, dimension);
    const thenRoot = region.findRoot(base, b.world, dimension);
    const nowRoot = region.findRoot(this.mcDir, b.world, dimension);
    const cells = new Array(a.w * a.h).fill('-');
    const blocks = new Array(a.w * a.h).fill(0);
    const contents = new Array(a.w * a.h).fill(0);
    const counts = { same: 0, blocks: 0, contents: 0, added: 0, gone: 0, empty: 0 };
    const KEY = { '.': 'same', b: 'blocks', c: 'contents', n: 'added', g: 'gone', '-': 'empty' };
    let done = 0;
    for (const [key, list] of groups) {
      const [rx, rz] = key.split(',').map(Number);
      const name = region.regionName(rx, rz);
      const then = region.parse(thenRoot ? readOrNull(path.join(base, thenRoot, 'region', name)) : null);
      const now = region.parse(nowRoot ? readOrNull(path.join(this.mcDir, nowRoot, 'region', name)) : null);
      for (const [cx, cz] of list) {
        const i = region.indexOf(cx, cz);
        const [v, n, c] = compareChunk(then[i], now[i]);
        const at = (cz - a.cz) * a.w + (cx - a.cx);
        cells[at] = v;
        blocks[at] = n;
        contents[at] = c;
        counts[KEY[v]]++;
        if (++done % 16 === 0) await new Promise(setImmediate); // other requests go on
      }
    }
    return { backup, dimension, world: b.world, found: Boolean(thenRoot), origin: { cx: a.cx, cz: a.cz }, w: a.w, h: a.h, cells: cells.join(''), blocks, contents, counts };
  }

  // Earlier area restores of the active world, newest first, for undo.
  async restores() {
    const world = await this.activeWorld();
    const dir = path.join(this.backupDir, '.area-restores', world);
    let stamps = [];
    try {
      stamps = (await fs.promises.readdir(dir)).filter((d) => names.STAMP_RE.test(d)).sort().reverse();
    } catch {}
    const out = [];
    for (const stamp of stamps) {
      try {
        const m = JSON.parse(await fs.promises.readFile(path.join(dir, stamp, 'meta.json'), 'utf8'));
        out.push({ stamp, at: m.at, from: m.from, dimension: m.dimension, chunks: Array.isArray(m.chunks) ? m.chunks.length : 0, entities: Array.isArray(m.kinds) && m.kinds.includes('entities') });
      } catch {}
    }
    return { world, restores: out };
  }

  checkChunks(chunks) {
    if (!Array.isArray(chunks) || !chunks.length) throw bad(400, 'Choose the chunks to restore');
    if (chunks.length > MAX_CHUNKS) throw bad(400, `At most ${MAX_CHUNKS} chunks at a time`);
    if (!chunks.every((c) => Array.isArray(c) && c.length === 2 && c.every((n) => Number.isInteger(n) && Math.abs(n) <= LIMIT / 16))) throw bad(400, 'Invalid chunk');
    return chunks;
  }

  // Stops the server (countdown, if it runs), writes the chunks, starts it.
  async restore({ backup, undo, dimension, chunks, entities = true, seconds = 30 }, user) {
    let args;
    let label;
    if (undo !== undefined) {
      if (!names.STAMP_RE.test(String(undo))) throw bad(400, 'Invalid restore');
      args = { undo };
      label = `Undo area restore of ${undo}`;
    } else {
      await this.checkBackup(backup);
      args = { backup, dimension: this.checkDimension(dimension), chunks: this.checkChunks(chunks), entities: Boolean(entities) };
      label = `Restore ${chunks.length} chunk${chunks.length === 1 ? '' : 's'} from ${backup}`;
    }
    seconds = Math.min(Math.max(Number(seconds) || 0, 0), 600);
    const st = await this.power.state();
    if (!st.available) throw bad(409, 'Restoring an area needs control of the server service (see README: polkit rule)');
    return this.ops.start(label, user, async (step) => {
      // Starting counts as running: it would load the chunks being written.
      const running = !['inactive', 'failed'].includes((await this.power.state()).active);
      if (running) {
        step(seconds ? `stopping in ${seconds}s` : 'stopping');
        await this.countdown.start(seconds, 'restore part of the world', { verb: 'stopping', finish: () => this.power.run('stop') });
        await this.power.waitFor(['inactive', 'failed']);
      }
      let result;
      try {
        step('restoring');
        result = await this.jobs.run('area-restore', args);
      } finally {
        if (running) {
          step('starting the server');
          await this.power.run('start');
        }
      }
      return result;
    });
  }
}

module.exports = { AreaRestore, compareChunk, fingerprint, sectionBlocks, MAX_CHUNKS };

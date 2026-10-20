'use strict';

// A player's profile: live state over RCON (`data get entity`) when they are
// online, the last saved inventory from the player's .dat file, and
// statistics and advancements from the world's files. Minecraft 26.1 moved
// these from <world>/playerdata|stats|advancements to <world>/players/
// data|stats|advancements; both layouts are read.

const fs = require('fs');
const path = require('path');
const { entityData } = require('./snbt');
const nbt = require('./nbt');
const props = require('./properties');

const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'];
const ARMOR_SLOTS = { 100: 'feet', 101: 'legs', 102: 'chest', 103: 'head', '-106': 'offhand' };

const LEGACY_DIRS = { data: 'playerdata', stats: 'stats', advancements: 'advancements' };

const short = (id) => String(id || '').replace(/^minecraft:/, '');
// A text component as SNBT (26.x: {text: "…", italic: 0b}), a JSON string
// (older versions) or plain text → its plain text.
function textOf(v) {
  if (v == null) return null;
  if (typeof v === 'object') return [v.text ?? '', ...(Array.isArray(v.extra) ? v.extra.map(textOf) : [])].join('') || null;
  const str = String(v);
  if (/^[{["]/.test(str)) {
    try {
      return textOf(JSON.parse(str));
    } catch {}
  }
  return str || null;
}

const item = (x) => x && x.id ? {
  id: short(x.id),
  count: x.count ?? x.Count ?? 1,
  enchanted: Boolean(x.components?.['minecraft:enchantments'] || x.components?.['minecraft:stored_enchantments'] || x.tag?.Enchantments?.length || x.tag?.StoredEnchantments?.length),
  name: textOf(x.components?.['minecraft:custom_name']),
} : null;

// [I; a, b, c, d] → "xxxxxxxx-xxxx-…"
function uuidFromInts(ints) {
  if (!Array.isArray(ints) || ints.length !== 4) return null;
  const hex = ints.map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Inventory list + equipment compound → hotbar, main inventory and gear.
function items(inventory, equipment) {
  const slots = Array.isArray(inventory) ? inventory : [];
  const main = Array.from({ length: 36 }, (_, i) => item(slots.find((x) => x?.Slot === i)));
  const gear = { head: null, chest: null, legs: null, feet: null, offhand: null };
  for (const x of slots) if (ARMOR_SLOTS[x?.Slot]) gear[ARMOR_SLOTS[x.Slot]] = item(x);
  if (equipment && typeof equipment === 'object') for (const k of Object.keys(gear)) if (equipment[k]) gear[k] = item(equipment[k]);
  return { hotbar: main.slice(0, 9), inventory: main.slice(9), gear };
}

function top(obj, n = 5) {
  return Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([id, count]) => ({ id: short(id), count }));
}

class PlayerInfo {
  constructor({ mcDir, rcon, log = () => {} }) {
    Object.assign(this, { mcDir, rcon, log });
  }

  worldDir() {
    let level = 'world';
    try {
      level = props.toObject(props.parse(fs.readFileSync(path.join(this.mcDir, 'server.properties'), 'utf8')))['level-name'] || 'world';
    } catch {}
    return path.join(this.mcDir, level);
  }

  // <world>/players/<kind>/<uuid>.<ext> (26.1+) or the older location.
  playerFile(kind, uuid, ext) {
    const world = this.worldDir();
    for (const dir of [path.join(world, 'players', kind), path.join(world, LEGACY_DIRS[kind])]) {
      const f = path.join(dir, `${uuid}.${ext}`);
      if (fs.existsSync(f)) return f;
    }
    return null;
  }

  readJson(kind, uuid) {
    const f = uuid && this.playerFile(kind, uuid, 'json');
    if (!f) return null;
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  // The player's last saved state (written on autosave and on logout).
  saved(uuid) {
    const f = uuid && this.playerFile('data', uuid, 'dat');
    if (!f) return null;
    try {
      const root = nbt.read(fs.readFileSync(f));
      return { savedAt: fs.statSync(f).mtime.toISOString(), selected: typeof root.SelectedItemSlot === 'number' ? root.SelectedItemSlot : null, ...items(root.Inventory, root.equipment) };
    } catch (err) {
      if (!(this.dataLogged ||= new Set()).has(f)) this.log(`player data ${path.basename(f)}: ${err.message}`); // once per file
      this.dataLogged.add(f);
      return null;
    }
  }

  uuidOf(name) {
    try {
      const cache = JSON.parse(fs.readFileSync(path.join(this.mcDir, 'usercache.json'), 'utf8'));
      const hit = cache.find((e) => String(e.name).toLowerCase() === name.toLowerCase());
      if (hit && UUID_RE.test(hit.uuid)) return hit.uuid;
    } catch {}
    return null;
  }

  async get(path_, state) {
    let skipped = 0;
    const onSkip = (around) => {
      if (skipped++ || this.skipLogged?.has(path_)) return; // once per query and process: enough to see what's new
      (this.skipLogged ||= new Set()).add(path_);
      this.log(`${path_}: skipped a value rconsole can't read yet, near: ${JSON.stringify(around)}`);
    };
    return entityData(await this.rcon.send(path_), { onSkip, state });
  }

  // One item at an NBT path, or undefined when there is none. When the reply
  // was cut short, the fields that matter are asked for one by one.
  async fullItem(q, p) {
    const state = {};
    const x = await q(p, state);
    if (!x || typeof x !== 'object' || Array.isArray(x)) return x === undefined ? undefined : null;
    if (!state.truncated) return x;
    for (const k of ['id', 'count', 'Slot']) if (x[k] === undefined) x[k] = await q(`${p}.${k}`);
    const components = { ...(typeof x.components === 'object' ? x.components : {}) };
    const wanted = ['minecraft:enchantments', 'minecraft:custom_name', ...(short(x.id) === 'enchanted_book' ? ['minecraft:stored_enchantments'] : [])];
    for (const c of wanted) {
      if (components[c] !== undefined) continue;
      const v = await q(`${p}.components."${c}"`, {});
      if (v !== undefined) components[c] = v;
    }
    return { ...x, components };
  }

  // Minecraft 26.x shortens long `data get` replies, so a whole inventory
  // rarely fits: then it is read item by item.
  async itemList(q) {
    const out = [];
    for (let i = 0; i < 64; i++) {
      const x = await this.fullItem(q, `Inventory[${i}]`);
      if (x === undefined) break;
      if (x) out.push(x);
    }
    return out;
  }

  async equipment(q) {
    const out = {};
    for (const k of ['head', 'chest', 'legs', 'feet', 'offhand']) {
      const x = await this.fullItem(q, `equipment.${k}`);
      if (x) out[k] = x;
    }
    return out;
  }

  // Live state, or null when the player isn't online. Values that can't be
  // read over RCON are logged and left out rather than failing the profile.
  async live(name, { inventory: withInventory = true } = {}) {
    const q = (p, state) => this.get(`data get entity ${name} ${p}`, state).catch((err) => {
      this.log(`player ${name}: can't read ${p}: ${err.message}`);
      return undefined;
    });
    const pos = await q('Pos');
    if (!Array.isArray(pos)) return null;
    const invState = {};
    const gearState = {};
    const skip = async () => undefined;
    let [dimension, health, food, xp, mode, selected, inventory, equipment, uuid] = await Promise.all([
      q('Dimension'), q('Health'), q('foodLevel'), q('XpLevel'), q('playerGameType'), q('SelectedItemSlot'),
      ...(withInventory ? [q('Inventory', invState), q('equipment', gearState), q('UUID')] : [skip(), skip(), skip()]),
    ]);
    if (invState.truncated) inventory = await this.itemList(q);
    if (gearState.truncated) equipment = await this.equipment(q);
    return {
      pos: pos.map((v) => Math.round(v * 10) / 10),
      dimension: short(dimension) || null,
      health: typeof health === 'number' ? Math.round(health * 10) / 10 : null,
      food: typeof food === 'number' ? food : null,
      xp: typeof xp === 'number' ? xp : null,
      gamemode: GAMEMODES[mode] || null,
      selected: typeof selected === 'number' ? selected : null,
      uuid: uuidFromInts(uuid),
      ...(withInventory ? {
        inventoryRead: Array.isArray(inventory) && !invState.skipped, // partial: prefer the saved copy if there is one
        ...items(inventory, equipment),
      } : {}),
    };
  }

  // Only what changes from second to second (no inventory, no files): what
  // an open profile polls. Shares a running request like profile().
  vitals(name) {
    if (!NAME_RE.test(String(name))) return Promise.reject(Object.assign(new Error('Invalid player name'), { status: 400 }));
    const key = `vitals:${String(name).toLowerCase()}`;
    this.inflight ||= new Map();
    if (!this.inflight.has(key)) {
      this.inflight.set(key, this.live(name, { inventory: false }).catch(() => null)
        .then((live) => ({ name, online: Boolean(live), live }))
        .finally(() => this.inflight.delete(key)));
    }
    return this.inflight.get(key);
  }

  stats(uuid) {
    const file = this.readJson('stats', uuid);
    if (!file) return null;
    const raw = file.stats || {};
    const c = raw['minecraft:custom'] || {};
    const sum = (o) => Object.values(o || {}).reduce((n, v) => n + v, 0);
    const walkedCm = ['walk_one_cm', 'sprint_one_cm', 'crouch_one_cm', 'swim_one_cm', 'walk_on_water_one_cm', 'walk_under_water_one_cm']
      .reduce((n, k) => n + (c[`minecraft:${k}`] || 0), 0);
    return {
      playTimeTicks: c['minecraft:play_time'] ?? c['minecraft:play_one_minute'] ?? null,
      deaths: c['minecraft:deaths'] || 0,
      mobKills: c['minecraft:mob_kills'] || 0,
      playerKills: c['minecraft:player_kills'] || 0,
      jumps: c['minecraft:jump'] || 0,
      walkedKm: Math.round(walkedCm / 1000) / 100,
      flownKm: Math.round((c['minecraft:fly_one_cm'] || 0) / 1000) / 100,
      blocksMined: sum(raw['minecraft:mined']),
      itemsCrafted: sum(raw['minecraft:crafted']),
      topMined: top(raw['minecraft:mined']),
      topUsed: top(raw['minecraft:used']),
      topKilled: top(raw['minecraft:killed'], 3),
    };
  }

  advancements(uuid) {
    const all = this.readJson('advancements', uuid);
    if (!all) return null;
    const done = Object.entries(all).filter(([k, v]) => !k.startsWith('minecraft:recipes/') && k !== 'DataVersion' && v?.done);
    return { done: done.length, latest: done.map(([k]) => short(k)).slice(-3) };
  }

  // Requests for the same player while one is running share its result
  // (a double click or two open tabs don't double the RCON queries).
  profile(name, opts = {}) {
    if (!NAME_RE.test(String(name))) return Promise.reject(Object.assign(new Error('Invalid player name'), { status: 400 }));
    const key = String(name).toLowerCase();
    this.inflight ||= new Map();
    if (!this.inflight.has(key)) this.inflight.set(key, this.build(name, opts).finally(() => this.inflight.delete(key)));
    return this.inflight.get(key);
  }

  async build(name, { uuid } = {}) {
    const live = await this.live(name).catch(() => null);
    uuid = live?.uuid || (UUID_RE.test(uuid || '') ? uuid : this.uuidOf(name));
    const saved = this.saved(uuid);
    // Over RCON the inventory can fail to parse (a large reply, an unusual
    // item); the saved copy is then the next best thing.
    if (live && !live.inventoryRead && saved) Object.assign(live, { hotbar: saved.hotbar, inventory: saved.inventory, gear: saved.gear, inventoryFrom: saved.savedAt });
    if (live) delete live.inventoryRead;
    return { name, uuid, online: Boolean(live), live, saved: live ? null : saved, stats: this.stats(uuid), advancements: this.advancements(uuid) };
  }
}

module.exports = { PlayerInfo, GAMEMODES, uuidFromInts, items };

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
const item = (x) => x && x.id ? {
  id: short(x.id),
  count: x.count ?? x.Count ?? 1,
  enchanted: Boolean(x.components?.['minecraft:enchantments'] || x.tag?.Enchantments?.length),
  name: x.components?.['minecraft:custom_name'] ? String(x.components['minecraft:custom_name']).replace(/^"|"$/g, '') : null,
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
      this.log(`player data ${path.basename(f)}: ${err.message}`);
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

  async get(path_) {
    return entityData(await this.rcon.send(path_));
  }

  // Live state, or null when the player isn't online. Values that can't be
  // read over RCON are logged and left out rather than failing the profile.
  async live(name) {
    const q = (p) => this.get(`data get entity ${name} ${p}`).catch((err) => {
      this.log(`player ${name}: can't read ${p}: ${err.message}`);
      return undefined;
    });
    const pos = await q('Pos');
    if (!Array.isArray(pos)) return null;
    const [dimension, health, food, xp, mode, inventory, equipment, selected, uuid] = await Promise.all([
      q('Dimension'), q('Health'), q('foodLevel'), q('XpLevel'), q('playerGameType'), q('Inventory'), q('equipment'), q('SelectedItemSlot'), q('UUID'),
    ]);
    return {
      pos: pos.map((v) => Math.round(v * 10) / 10),
      dimension: short(dimension) || null,
      health: typeof health === 'number' ? Math.round(health * 10) / 10 : null,
      food: typeof food === 'number' ? food : null,
      xp: typeof xp === 'number' ? xp : null,
      gamemode: GAMEMODES[mode] || null,
      selected: typeof selected === 'number' ? selected : null,
      uuid: uuidFromInts(uuid),
      inventoryRead: Array.isArray(inventory),
      ...items(inventory, equipment),
    };
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

  async profile(name, { uuid } = {}) {
    if (!NAME_RE.test(String(name))) throw Object.assign(new Error('Invalid player name'), { status: 400 });
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

module.exports = { PlayerInfo, GAMEMODES, uuidFromInts };

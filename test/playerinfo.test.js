'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PlayerInfo } = require('../lib/playerinfo');

const UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5';

test('playerinfo: live state over RCON, stats and advancements from files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-player-'));
  fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=survival\n');
  fs.writeFileSync(path.join(dir, 'usercache.json'), JSON.stringify([{ name: 'Notch', uuid: UUID }]));
  fs.mkdirSync(path.join(dir, 'survival/stats'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'survival/advancements'), { recursive: true });
  fs.writeFileSync(path.join(dir, `survival/stats/${UUID}.json`), JSON.stringify({ stats: {
    'minecraft:custom': { 'minecraft:play_time': 72000, 'minecraft:deaths': 3, 'minecraft:mob_kills': 41, 'minecraft:walk_one_cm': 150000, 'minecraft:sprint_one_cm': 50000, 'minecraft:jump': 900 },
    'minecraft:mined': { 'minecraft:stone': 500, 'minecraft:dirt': 120, 'minecraft:diamond_ore': 4 },
    'minecraft:used': { 'minecraft:diamond_pickaxe': 610 },
  } }));
  fs.writeFileSync(path.join(dir, `survival/advancements/${UUID}.json`), JSON.stringify({
    'minecraft:story/mine_stone': { done: true }, 'minecraft:story/smelt_iron': { done: true }, 'minecraft:nether/root': { done: false }, 'minecraft:recipes/misc/x': { done: true }, DataVersion: 4000,
  }));
  const replies = {
    'data get entity Notch Pos': 'Notch has the following entity data: [12.34d, 64.0d, -5.66d]',
    'data get entity Notch Dimension': 'Notch has the following entity data: "minecraft:the_nether"',
    'data get entity Notch Health': 'Notch has the following entity data: 17.5f',
    'data get entity Notch foodLevel': 'Notch has the following entity data: 20',
    'data get entity Notch XpLevel': 'Notch has the following entity data: 30',
    'data get entity Notch playerGameType': 'Notch has the following entity data: 0',
    'data get entity Notch SelectedItemSlot': 'Notch has the following entity data: 1',
    'data get entity Notch Inventory': 'Notch has the following entity data: [{count: 1, Slot: 0b, id: "minecraft:diamond_sword", components: {"minecraft:enchantments": {levels: {"minecraft:sharpness": 5}}}}, {count: 32, Slot: 1b, id: "minecraft:torch"}, {count: 1, Slot: 103b, id: "minecraft:iron_helmet"}, {count: 5, Slot: 9b, id: "minecraft:bread"}]',
    'data get entity Notch equipment': 'Found no elements matching equipment',
  };
  const rcon = { send: async (c) => replies[c] ?? 'No entity was found' };
  const info = new PlayerInfo({ mcDir: dir, rcon });
  const p = await info.profile('Notch');
  assert.strictEqual(p.uuid, UUID);
  assert.strictEqual(p.online, true);
  assert.deepStrictEqual(p.live.pos, [12.3, 64, -5.7]);
  assert.strictEqual(p.live.dimension, 'the_nether');
  assert.strictEqual(p.live.gamemode, 'survival');
  assert.deepStrictEqual(p.live.hotbar[0], { id: 'diamond_sword', count: 1, enchanted: true, name: null });
  assert.strictEqual(p.live.hotbar[1].count, 32);
  assert.strictEqual(p.live.inventory[0].id, 'bread');
  assert.strictEqual(p.live.gear.head.id, 'iron_helmet');
  assert.strictEqual(p.stats.deaths, 3);
  assert.strictEqual(p.stats.walkedKm, 2);
  assert.strictEqual(p.stats.blocksMined, 624);
  assert.deepStrictEqual(p.stats.topMined[0], { id: 'stone', count: 500 });
  assert.deepStrictEqual(p.advancements.done, 2);

  const off = await info.profile('Steve');
  assert.deepStrictEqual([off.online, off.live, off.stats], [false, null, null]);
  await assert.rejects(info.profile('bad name;'), /Invalid player name/);
});

// A tiny NBT writer for fixtures: { name: [type, value] } pairs.
function nbtWrite(root) {
  const parts = [];
  const str = (s) => {
    const b = Buffer.from(s, 'utf8');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(b.length);
    parts.push(len, b);
  };
  const num = (fn, size, v) => {
    const b = Buffer.alloc(size);
    b[fn](v);
    parts.push(b);
  };
  const payload = ([type, v]) => {
    if (type === 1) num('writeInt8', 1, v);
    else if (type === 3) num('writeInt32BE', 4, v);
    else if (type === 5) num('writeFloatBE', 4, v);
    else if (type === 6) num('writeDoubleBE', 8, v);
    else if (type === 8) str(v);
    else if (type === 9) {
      parts.push(Buffer.from([v.length ? v[0][0] : 0]));
      num('writeInt32BE', 4, v.length);
      for (const x of v) payload(x);
    } else if (type === 10) {
      for (const [k, x] of Object.entries(v)) {
        parts.push(Buffer.from([x[0]]));
        str(k);
        payload(x);
      }
      parts.push(Buffer.from([0]));
    } else if (type === 11) {
      num('writeInt32BE', 4, v.length);
      for (const x of v) num('writeInt32BE', 4, x);
    }
  };
  parts.push(Buffer.from([10]));
  str('');
  payload([10, root]);
  return require('zlib').gzipSync(Buffer.concat(parts));
}

test('playerinfo: Minecraft 26.1 layout (players/…), UUID over RCON, saved inventory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-player26-'));
  fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=world\n');
  for (const d of ['data', 'stats', 'advancements']) fs.mkdirSync(path.join(dir, 'world/players', d), { recursive: true });
  fs.writeFileSync(path.join(dir, `world/players/stats/${UUID}.json`), JSON.stringify({ stats: { 'minecraft:custom': { 'minecraft:play_time': 3456000, 'minecraft:deaths': 7 } } }));
  fs.writeFileSync(path.join(dir, `world/players/advancements/${UUID}.json`), JSON.stringify({ 'minecraft:story/root': { done: true } }));
  const itemTag = (slot, id, count, extra = {}) => [10, { Slot: [1, slot], id: [8, id], count: [3, count], ...extra }];
  fs.writeFileSync(path.join(dir, `world/players/data/${UUID}.dat`), nbtWrite({
    Health: [5, 20], SelectedItemSlot: [3, 2],
    Inventory: [9, [itemTag(0, 'minecraft:netherite_pickaxe', 1, { components: [10, { 'minecraft:enchantments': [10, { 'minecraft:efficiency': [3, 5] }] }] }), itemTag(2, 'minecraft:oak_log', 48), itemTag(20, 'minecraft:cooked_beef', 12)]],
    equipment: [10, { chest: [10, { id: [8, 'minecraft:elytra'], count: [3, 1] }] }],
  }));
  // The online player's inventory reply doesn't parse; their UUID comes over RCON (no usercache.json).
  const replies = {
    'data get entity Alex Pos': 'Alex has the following entity data: [-251.3d, -38.0d, -364.7d]',
    'data get entity Alex Health': 'Alex has the following entity data: 20.0f',
    'data get entity Alex Inventory': 'Alex has the following entity data: [{count: 1, Slot: 0b, id: "minecraft:netherite_pick',
    'data get entity Alex UUID': 'Alex has the following entity data: [I; 110787060, 1156138790, -1514210135, 238594805]',
  };
  const logs = [];
  const info = new PlayerInfo({ mcDir: dir, rcon: { send: async (c) => replies[c] ?? 'Found no elements matching x' }, log: (m) => logs.push(m) });
  const p = await info.profile('Alex');
  assert.strictEqual(p.uuid, UUID);
  assert.strictEqual(p.online, true);
  assert.strictEqual(p.live.hotbar[0].id, 'netherite_pickaxe');
  assert.strictEqual(p.live.hotbar[0].enchanted, true);
  assert.strictEqual(p.live.hotbar[2].count, 48);
  assert.strictEqual(p.live.inventory[11].id, 'cooked_beef');
  assert.strictEqual(p.live.gear.chest.id, 'elytra');
  assert.ok(p.live.inventoryFrom);
  assert.ok(logs.some((l) => /can't read Inventory/.test(l)));
  assert.strictEqual(p.stats.deaths, 7);
  assert.strictEqual(p.stats.playTimeTicks, 3456000);
  assert.strictEqual(p.advancements.done, 1);

  // Offline: the saved inventory, stats from the files.
  const off = await new PlayerInfo({ mcDir: dir, rcon: { send: async () => 'No entity was found' } }).profile('Alex', { uuid: UUID });
  assert.strictEqual(off.online, false);
  assert.strictEqual(off.saved.selected, 2);
  assert.strictEqual(off.saved.hotbar[2].id, 'oak_log');
  assert.strictEqual(off.stats.deaths, 7);
});

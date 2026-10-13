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
  assert.ok(logs.some((l) => /Inventory: skipped/.test(l)));
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

// Paper 26.3 cuts `data get` replies short ("...") once they get long.
test('playerinfo: truncated replies are read item by item', async () => {
  const typed = (v) => (typeof v === 'number' ? `${v}` : typeof v === 'string' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(typed).join(', ')}]`
    : `{${Object.entries(v).map(([k, x]) => `${/^[A-Za-z0-9_]+$/.test(k) ? k : JSON.stringify(k)}: ${typed(x)}`).join(', ')}}`);
  const enchanted = { 'minecraft:damage': 37, 'minecraft:enchantments': { 'minecraft:sharpness': 5, 'minecraft:unbreaking': 3 } };
  const player = {
    Pos: [-192.3, -38, -340.2], Health: 20, SelectedItemSlot: 1,
    UUID: [110787060, 1156138790, -1514210135, 238594805],
    Inventory: [
      { Slot: 0, id: 'minecraft:diamond_sword', count: 1, components: enchanted },
      { Slot: 1, id: 'minecraft:diamond_pickaxe', count: 1, components: { 'minecraft:damage': 3, 'minecraft:custom_name': { text: 'Digger' } } },
      { Slot: 2, id: 'minecraft:torch', count: 64 },
      { Slot: 17, id: 'minecraft:light_blue_stained_glass_pane', count: 48 },
      { Slot: 18, id: 'minecraft:enchanted_book', count: 1, components: { 'minecraft:stored_enchantments': { 'minecraft:mending': 1, 'minecraft:unbreaking': 3 } } },
    ],
    equipment: { legs: { id: 'minecraft:diamond_leggings', count: 1, components: { 'minecraft:damage': 118 } }, chest: { id: 'minecraft:elytra', count: 1, components: { 'minecraft:damage': 4 } } },
  };
  const resolve = (p) => {
    let v = player;
    for (const m of p.matchAll(/([A-Za-z_]+)|\[(\d+)\]|"([^"]+)"/g)) {
      v = v?.[m[1] ?? m[2] ?? m[3]];
      if (v === undefined) return undefined;
    }
    return v;
  };
  const queries = [];
  const rcon = { send: async (c) => {
    queries.push(c);
    const m = c.match(/^data get entity Alex (.+)$/);
    const v = m && resolve(m[1]);
    if (v === undefined) return `Found no elements matching ${m?.[1]}`;
    const text = typed(v);
    return `Alex has the following entity data: ${text.length > 88 ? `${text.slice(0, 85)}...` : text}`;
  } };
  const p = await new PlayerInfo({ mcDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-trunc-')), rcon }).profile('Alex');
  assert.deepStrictEqual(p.live.hotbar.slice(0, 3).map((x) => x && [x.id, x.count, x.enchanted, x.name]),
    [['diamond_sword', 1, true, null], ['diamond_pickaxe', 1, false, 'Digger'], ['torch', 64, false, null]]);
  assert.strictEqual(p.live.inventory[8].id, 'light_blue_stained_glass_pane');
  assert.strictEqual(p.live.inventory[9].enchanted, true);
  assert.strictEqual(p.live.gear.legs.id, 'diamond_leggings');
  assert.strictEqual(p.live.gear.chest.id, 'elytra');
  assert.strictEqual(p.live.gear.head, null);
  assert.ok(queries.length < 40, `${queries.length} queries`);
});

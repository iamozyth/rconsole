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

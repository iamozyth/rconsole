'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parse, entityData } = require('../lib/snbt');

test('snbt: values, nesting, typed arrays and quoting', () => {
  assert.deepStrictEqual(parse('[12.5d, 64.0d, -3.25d]'), [12.5, 64, -3.25]);
  assert.deepStrictEqual(parse('{Health: 20.0f, foodLevel: 18, XpLevel: 7, playerGameType: 0, OnGround: 1b, ok: true}'), { Health: 20, foodLevel: 18, XpLevel: 7, playerGameType: 0, OnGround: 1, ok: true });
  assert.deepStrictEqual(parse('[I; 1, -2, 3]'), [1, -2, 3]);
  assert.deepStrictEqual(parse(`{"minecraft:custom_name": 'It\\'s "mine"', id: "minecraft:stone", empty: [], e2: {}}`), { 'minecraft:custom_name': `It's "mine"`, id: 'minecraft:stone', empty: [], e2: {} });
  // 1.20.5+ inventory items
  const inv = parse('[{count: 1, Slot: 0b, id: "minecraft:diamond_sword", components: {"minecraft:enchantments": {levels: {"minecraft:sharpness": 5}}}}, {count: 64, Slot: 1b, id: "minecraft:cobblestone"}]');
  assert.strictEqual(inv[0].components['minecraft:enchantments'].levels['minecraft:sharpness'], 5);
  assert.strictEqual(inv[1].count, 64);
  assert.deepStrictEqual(entityData('Steve has the following entity data: "minecraft:overworld"'), 'minecraft:overworld');
  assert.strictEqual(entityData('No entity was found'), undefined);
  assert.throws(() => parse('{a: [1, 2}'), /SNBT/);
});

test('snbt: unknown syntax is skipped and reported, the rest survives', () => {
  const { parse } = require('../lib/snbt');
  const t = '[{Slot: 0b, components: {"minecraft:damage": 12, odd: bool(1), "minecraft:x": {k: uuid("a,b")}}, count: 1, id: "minecraft:iron_pickaxe"}, {Slot: 1b, count: 64, id: "minecraft:stone"}]';
  const seen = [];
  const v = parse(t, { onSkip: (around) => seen.push(around) });
  assert.deepStrictEqual(v.map((x) => [x.Slot, x.id, x.count]), [[0, 'minecraft:iron_pickaxe', 1], [1, 'minecraft:stone', 64]]);
  assert.strictEqual(v[0].components['minecraft:damage'], 12);
  assert.ok(seen.length >= 1 && seen.some((s) => s.includes('bool(1)')));
  assert.throws(() => parse(t), /expected , or }/);
});

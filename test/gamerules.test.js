'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { GameRules, parseRuleNames, catalogKey } = require('../lib/gamerules');

// What Paper 26.3 answers on `minecraft:help gamerule`, shortened.
const HELP_26 = ['/gamerule keep_inventory [<value>]', '/gamerule minecraft:keep_inventory [<value>]', '/gamerule random_tick_speed [<value>]', '/gamerule minecraft:random_tick_speed [<value>]', '/gamerule mymod:no_rain [<value>]'].join('\n');
// Minecraft 1.21 and earlier.
const HELP_121 = '/gamerule announceAdvancements [<value>]\n/gamerule doDaylightCycle [<value>]\n/gamerule keepInventory [<value>]';

test('reads which rules the server has, in both naming schemes', () => {
  assert.deepStrictEqual(parseRuleNames(HELP_26), ['keep_inventory', 'random_tick_speed', 'mymod:no_rain']);
  assert.deepStrictEqual(parseRuleNames(HELP_121), ['announceAdvancements', 'doDaylightCycle', 'keepInventory']);
  assert.deepStrictEqual(parseRuleNames('--------- Help: /gamerule ---------\nDescription: Sets or queries a game rule value.'), []);
  assert.deepStrictEqual(['keepInventory', 'doDaylightCycle', 'announceAdvancements', 'minecraft:pvp', 'mymod:no_rain'].map(catalogKey), ['keep_inventory', 'advance_time', 'show_advancement_messages', 'pvp', 'mymod:no_rain']);
});

// A server with per-world rules (Paper) and no End.
function fakeServer({ help = HELP_26, end = false } = {}) {
  const worlds = { 'minecraft:overworld': { keep_inventory: 'false', random_tick_speed: '3', 'mymod:no_rain': 'true' }, 'minecraft:the_nether': { keep_inventory: 'true', random_tick_speed: '3', 'mymod:no_rain': 'true' } };
  if (end) worlds['minecraft:the_end'] = { ...worlds['minecraft:overworld'] };
  const sent = [];
  const rcon = {
    async send(cmd) {
      sent.push(cmd);
      if (/help gamerule$/.test(cmd)) return help;
      const m = /^(?:execute in (\S+) run )?gamerule (\S+)(?: (\S+))?$/.exec(cmd);
      const w = worlds[m[1] || 'minecraft:overworld'];
      if (!w) return `Unknown dimension '${m[1]}'\n...<--[HERE]`;
      if (!(m[2] in w)) return 'Incorrect argument for command';
      if (m[3] === undefined) return `Game rule ${m[2]} is currently set to ${w[m[2]]}`;
      if (/^\d+$/.test(w[m[2]]) && !/^\d+$/.test(m[3])) return 'Expected integer\n...<--[HERE]';
      if (w[m[2]] === m[3]) return `Game rule ${m[2]} is already set to ${m[3]}`;
      w[m[2]] = m[3];
      return `Game rule ${m[2]} is now set to ${m[3]}`;
    },
  };
  return { rcon, worlds, sent };
}

test('shows each rule with words, a group and the worlds that differ', async () => {
  const { rcon } = fakeServer();
  const v = await new GameRules({ rcon }).view();
  assert.deepStrictEqual(v.worlds, ['Overworld', 'Nether']);
  const keep = v.rules.find((r) => r.name === 'keep_inventory');
  assert.deepStrictEqual([keep.label, keep.group, keep.common, keep.type, keep.value, keep.differs], ['Keep inventory', 'Players', true, 'bool', 'false', [{ world: 'Nether', value: 'true' }]]);
  assert.strictEqual(v.rules.find((r) => r.name === 'random_tick_speed').type, 'int');
  const mod = v.rules.find((r) => r.name === 'mymod:no_rain');
  assert.deepStrictEqual([mod.label, mod.group, mod.known], ['mymod:no_rain', 'Advanced', false], 'rules from mods show up too');
});

test('changes rules in every world, or in the Overworld only', async () => {
  const { rcon, worlds, sent } = fakeServer({ end: true });
  const g = new GameRules({ rcon });
  assert.deepStrictEqual(await g.set([{ name: 'keep_inventory', value: true }, { name: 'random_tick_speed', value: 10 }]), { changed: 2 });
  assert.deepStrictEqual(Object.values(worlds).map((w) => [w.keep_inventory, w.random_tick_speed]), [['true', '10'], ['true', '10'], ['true', '10']]);
  await g.set([{ name: 'keep_inventory', value: 'false' }], { all: false });
  assert.deepStrictEqual(Object.values(worlds).map((w) => w.keep_inventory), ['false', 'true', 'true']);
  assert.ok(sent.includes('execute in minecraft:the_end run gamerule random_tick_speed 10'));

  await assert.rejects(g.set([{ name: 'keep_inventory; op Steve', value: 'true' }]), /Unknown game rule/);
  await assert.rejects(g.set([{ name: 'gamemode', value: 'true' }]), /Unknown game rule/);
  await assert.rejects(g.set([{ name: 'keep_inventory', value: 'true; op Steve' }]), /true, false or a whole number/);
  await assert.rejects(g.set([{ name: 'random_tick_speed', value: 'true' }]), /random_tick_speed: Expected integer/);
  await assert.rejects(g.set([]), /Nothing to change/);

  // No End on this server: the overworld and Nether change, no error.
  const noEnd = fakeServer();
  await new GameRules({ rcon: noEnd.rcon }).set([{ name: 'keep_inventory', value: 'true' }]);
  assert.strictEqual(noEnd.worlds['minecraft:overworld'].keep_inventory, 'true');
});

test('works with the names before Minecraft 26', async () => {
  const worlds = { keepInventory: 'false', doDaylightCycle: 'true', announceAdvancements: 'true' };
  const rcon = {
    async send(cmd) {
      if (cmd === 'minecraft:help gamerule') return HELP_121;
      const m = /gamerule (\S+)(?: (\S+))?$/.exec(cmd);
      if (m[2]) worlds[m[1]] = m[2];
      return `Gamerule ${m[1]} is ${m[2] ? 'now' : 'currently'} set to: ${worlds[m[1]]}`;
    },
  };
  const v = await new GameRules({ rcon }).view();
  assert.deepStrictEqual(v.rules.map((r) => [r.name, r.label]).sort(), [['announceAdvancements', 'Advancement messages'], ['doDaylightCycle', 'Day and night cycle'], ['keepInventory', 'Keep inventory']]);
  await new GameRules({ rcon }).set([{ name: 'keepInventory', value: 'true' }]);
  assert.strictEqual(worlds.keepInventory, 'true');
});

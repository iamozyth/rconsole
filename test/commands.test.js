'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseUsage, parseHelp, CommandCatalog } = require('../lib/commands');

test('parseUsage reads minecraft:help lines', () => {
  const u = parseUsage('/gamemode <gamemode> [<target>]\n/seed\n/whitelist (add|remove)\nnoise');
  assert.deepStrictEqual([...u.keys()], ['gamemode', 'seed', 'whitelist']);
  assert.deepStrictEqual(u.get('gamemode'), ['<gamemode> [<target>]']);
  assert.deepStrictEqual(u.get('seed'), []);
});

test('parseHelp strips colours and reads pages', () => {
  const h = parseHelp('§e--------- §fHelp: Index (1/3) §e---\n§6/chunky: §fPre-generates chunks\n§6Aliases: §fLists command aliases');
  assert.strictEqual(h.pages, 3);
  assert.deepStrictEqual([...h.desc], [['chunky', 'Pre-generates chunks']]);
});

test('catalog merges pages, drops namespaced duplicates and keeps the last good list', async () => {
  const replies = { 'minecraft:help': '/say <message>\n/minecraft:say <message>', help: 'Help: Index (1/2)\n/say: Broadcast', 'help 2': '/spawn: Go to spawn' };
  let offline = false;
  const c = new CommandCatalog({ rcon: { send: async (cmd) => { if (offline) throw new Error('down'); return replies[cmd] || ''; } } });
  const r = await c.list();
  assert.deepStrictEqual(r.commands.map((x) => [x.name, x.usage, x.description]), [['say', ['<message>'], 'Broadcast'], ['spawn', [], 'Go to spawn']]);
  offline = true;
  const again = await c.list({ refresh: true });
  assert.strictEqual(again.commands.length, 2);
});

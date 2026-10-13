'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Stats } = require('../lib/stats');

test('stats: slow values are asked for rarely, the clock is advanced locally', async () => {
  let clock = 1_000_000;
  const tick = (ms) => { clock += ms; };
  const sent = [];
  const rcon = { send: async (c) => {
    sent.push(c);
    if (c === 'list') return 'There are 1 of a max of 20 players online: Alex';
    if (c === 'tps') return 'TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0';
    if (c === 'time query day') return 'Timeline minecraft:day is at 30000 tick(s)';
    return 'Unknown command';
  } };
  const s = new Stats({ rcon, mcDir: '/', now: () => clock });
  const first = await s.game();
  assert.deepStrictEqual([first.daytime, first.day, first.tps, first.players.online], [6000, 1, 20, 1]);
  assert.deepStrictEqual(sent, ['list', 'tps', 'time query day']);

  // 5 s later: nothing asked; the time moved on by 100 ticks.
  tick(5000);
  const g = await s.game();
  assert.strictEqual(sent.length, 3);
  assert.strictEqual(g.daytime, 6100);

  // 11 s: TPS again; 31 s: the list again; 61 s: the time again.
  tick(6000);
  await s.game();
  assert.deepStrictEqual(sent.slice(3), ['tps']);
  tick(20000);
  await s.game();
  assert.deepStrictEqual(sent.slice(4), ['list', 'tps']);
  tick(30000);
  const later = await s.game();
  assert.ok(sent.slice(6).includes('time query day'));
  assert.strictEqual(later.daytime, 6000); // the fake clock doesn't move: corrected by the fresh query

  // A join in the log: the next poll asks for the list right away.
  const before = sent.length;
  s.invalidate('players');
  await s.game();
  assert.deepStrictEqual(sent.slice(before), ['list']);
});

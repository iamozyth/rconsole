'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lag = require('../lib/lagdetective');

// Answers as Paper 26.3 gives them.
const PAPER = {
  mspt: '§6Server tick times §e(§7avg§e/§7min§e/§7max§e)§6 from last 5s§7,§6 10s§7,§6 1m§e:\n§6◴ §a1.3§7/§a0.8§7/§a4.0§e, §a1.2§7/§a0.8§7/§a4.0§e, §a2.3§7/§a0.7§7/§c262.3',
  tick: 'Average time per tick: 4.6ms (Target: 50.0ms)\nPercentiles: P50: 3.9ms P95: 8.2ms P99: 12.0ms, sample: 100',
  chunkinfo: 'Chunks in minecraft:overworld:\nTotal: 176 Inactive: 112 Full: 28 Block Ticking: 20 Entity Ticking: 16\nChunks in minecraft:the_nether:\nTotal: 0 Inactive: 0 Full: 0 Block Ticking: 0 Entity Ticking: 0\nChunks in all listed worlds:\nTotal: 176 Inactive: 112 Full: 28 Block Ticking: 20 Entity Ticking: 16',
  all: 'Total Ticking: 2034, Total Non-Ticking: 96\n  1800 (6) : minecraft:item\n  6 (16) : minecraft:zombie\n  0 (12) : minecraft:bat',
  items: 'Entity: minecraft:item Total Ticking: 1800, Total Non-Ticking: 6\n  1700: 12, -4 (Ticking)\n  100: 0, 0 (Ticking)\n  6: 30, 30 (Non-Ticking)',
};

test('reads what Paper answers', () => {
  assert.deepStrictEqual(lag.parseMspt(PAPER.mspt.replace(/§./g, '')), { avg: 1.3, max: 262.3, avg1m: 2.3 });
  assert.deepStrictEqual(lag.parseTickQuery(PAPER.tick), { avg: 4.6, p95: 8.2, p99: 12 });
  assert.deepStrictEqual(lag.parseChunkInfo(PAPER.chunkinfo).map((w) => [w.key, w.total, w.entityTicking]), [['minecraft:overworld', 176, 16], ['minecraft:the_nether', 0, 0]]);
  const e = lag.parseEntityList(PAPER.all);
  assert.deepStrictEqual([e.ticking, e.idle, e.types[0].type, e.types.length], [2034, 96, 'minecraft:item', 3]);
  assert.deepStrictEqual(lag.parseEntityChunks(PAPER.items)[0], { count: 1700, cx: 12, cz: -4, ticking: true });
  assert.deepStrictEqual(lag.parsePos('Lena has the following entity data: [5.5d, 68.0d, -8.5d]'), [5.5, 68, -8.5]);
  assert.strictEqual(lag.parseDim('Lena has the following entity data: "minecraft:the_nether"'), 'minecraft:the_nether');
  assert.strictEqual(lag.parseCount('Test passed. Count: 15'), 15);
  assert.strictEqual(lag.parseCount('Test failed'), 0);
});

function fakeRcon({ speed = 0 } = {}) {
  let looks = 0;
  return {
    sent: [],
    async send(cmd) {
      this.sent.push(cmd);
      if (cmd === 'mspt') return PAPER.mspt;
      if (cmd === 'tick query') return PAPER.tick;
      if (cmd === 'paper chunkinfo *') return looks++ ? PAPER.chunkinfo.replace(/Total: 176/g, 'Total: 300') : PAPER.chunkinfo;
      if (cmd === 'paper entity list * minecraft:overworld') return PAPER.all;
      if (cmd === 'paper entity list minecraft:item minecraft:overworld') return PAPER.items;
      if (cmd.startsWith('data get entity Lena Pos')) return `Lena has the following entity data: [${200 + (looks ? speed * 4 : 0)}.5d, 68.0d, -60.5d]`;
      if (cmd.startsWith('data get entity Lena Dimension')) return 'Lena has the following entity data: "minecraft:overworld"';
      return 'Unknown or incomplete command, see below for error';
    },
  };
}

const detective = (rcon, extra = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-lag-'));
  fs.writeFileSync(path.join(dir, 'server.properties'), 'view-distance=12\nsimulation-distance=10\n');
  return new lag.LagDetective({
    rcon,
    stateDir: dir,
    mcDir: dir,
    stats: { get: async () => ({ rcon: { ok: true }, game: { tps: 11.2, players: { online: 1, players: ['Lena'] } }, host: { cores: 4, cpu: 0.4 }, heap: { used: 3.9e9, max: 4e9 } }) },
    power: { processStats: async () => ({ cpu: 1.2 }) },
    ...extra,
  });
};

test('an investigation finds the pile of items, where it is, and who is near', async () => {
  const d = detective(fakeRcon({ speed: 30 }));
  const r = await d.investigate({ by: 'masseo' });
  const kinds = r.findings.map((f) => [f.severity, f.kind]);
  assert.deepStrictEqual(kinds.slice(0, 3), [['critical', 'entities'], ['critical', 'chunks'], ['critical', 'memory']]);
  const items = r.findings[0];
  assert.match(items.title, /1,800 items/);
  assert.match(items.detail, /chunk 12, -4 \(around 200 -56\), 121 blocks from Lena: 1,700 in one chunk/);
  assert.deepStrictEqual(items.action, { label: 'Remove items', command: 'kill @e[type=minecraft:item]' });
  assert.match(r.findings[1].detail, /Lena at 30 blocks\/s/);
  assert.match(r.findings[1].detail, /124 chunks loaded/);
  assert.strictEqual(r.headline, items.title);
  assert.ok(r.findings.some((f) => f.kind === 'spikes'), 'a 262 ms tick in the last minute');
  // Saved, and a second detective reads it.
  const again = new lag.LagDetective({ ...d, stateDir: path.dirname(d.file) });
  assert.strictEqual(again.view().reports[0].id, r.id);
  assert.strictEqual(again.report(r.id).findings.length, r.findings.length);
});

test('nothing found says so and points at spark; vanilla counts by type', async () => {
  const rcon = {
    async send(cmd) {
      if (cmd.startsWith('execute if entity')) return 'Test passed. Count: 12';
      if (cmd === 'tick query') return 'Average time per tick: 3.0ms (Target: 50.0ms)\nPercentiles: P50: 2.9ms P95: 4.0ms P99: 5.0ms, sample: 100';
      return 'Unknown or incomplete command, see below for error';
    },
  };
  const d = detective(rcon, { stats: { get: async () => ({ rcon: { ok: true }, game: { tps: 20, players: { online: 0, players: [] } }, host: { cores: 4, cpu: 0.1 }, heap: null }) } });
  const r = await d.investigate();
  assert.strictEqual(r.paper, false);
  assert.strictEqual(r.worlds[0].entities.ticking, 12);
  assert.deepStrictEqual(r.findings.map((f) => f.kind), ['none']);
  assert.ok(r.findings[0].spark);
});

test('two slow samples in a row start one investigation, then a pause', async () => {
  let now = 0;
  const d = detective(fakeRcon(), { now: () => now });
  let runs = 0;
  d.investigate = () => (runs++, Promise.resolve());
  d.onSample({ up: 1, tps: 12 });
  assert.strictEqual(runs, 0);
  d.onSample({ up: 1, tps: 12 });
  assert.strictEqual(runs, 1);
  now += 60000;
  d.onSample({ up: 1, tps: 12 });
  d.onSample({ up: 1, tps: 12 });
  assert.strictEqual(runs, 1, 'not again within 15 minutes');
  now += 15 * 60000;
  d.onSample({ up: 1, tps: 19 });
  d.onSample({ up: 1, tps: 12 });
  assert.strictEqual(runs, 1, 'the good sample reset the count');
  d.onSample({ up: 1, tps: 12 });
  assert.strictEqual(runs, 2);
});

test('the server must be running', async () => {
  const d = detective(fakeRcon(), { stats: { get: async () => ({ rcon: { ok: false } }) } });
  await assert.rejects(d.investigate(), /not running/);
});

test('at full speed a pile is something that could cause lag, not the cause', () => {
  const worlds = [{ key: 'minecraft:overworld', entities: { ticking: 1600, idle: 0, types: [{ type: 'minecraft:item', ticking: 1600, idle: 0 }] } }];
  const busy = lag.diagnose({ tps: 20, mspt: { avg: 11 }, worlds, hotspots: [], players: [] });
  assert.deepStrictEqual([busy[0].severity, busy[0].kind], ['warning', 'entities']);
  const slow = lag.diagnose({ tps: 12, mspt: { avg: 80 }, worlds, hotspots: [], players: [] });
  assert.strictEqual(slow[0].severity, 'critical');
});

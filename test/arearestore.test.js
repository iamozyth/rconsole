'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-area-'));
const MC = path.join(root, 'mc');
const BK = path.join(root, 'backups');
process.env.MC_DIR = MC;
process.env.BACKUP_DIR = BK;
process.env.STATE_DIR = path.join(root, 'state');

const region = require('../lib/region');
const nbtedit = require('../lib/nbtedit');
const { AreaRestore, compareChunk, sectionBlocks } = require('../lib/arearestore');
const { TASKS } = require('../bin/mc-helper');

const BACKUP = 'world-2026-10-20_21-09-01.tar.gz';
const DIM = path.join('world', 'dimensions', 'minecraft', 'overworld');

// NBT building blocks, as nbtedit keeps them.
const int = (n, type = 3) => {
  const b = Buffer.alloc(type === 1 ? 1 : 4);
  if (type === 1) b.writeInt8(n);
  else b.writeInt32BE(n);
  return { type, raw: b };
};
const string = (s) => ({ type: 8, raw: Buffer.from(s) });
const compound = (obj) => ({ type: 10, entries: Object.entries(obj).filter(([, v]) => v) });
const list = (of, items) => ({ type: 9, of, items });
function longs(indices, bits) {
  const per = Math.floor(64 / bits);
  const n = Math.ceil(4096 / per);
  const b = Buffer.alloc(4 + n * 8);
  b.writeInt32BE(n);
  for (let i = 0; i < 4096; i++) {
    const w = Math.floor(i / per);
    const cur = b.readBigUInt64BE(4 + w * 8);
    b.writeBigUInt64BE(cur | (BigInt(indices[i]) << BigInt((i % per) * bits)), 4 + w * 8);
  }
  return { type: 12, raw: b };
}

// A chunk: one section at Y 0 whose blocks come from blockAt(i) (names),
// written like 26.x (a list of strings as the palette), and block entities.
function chunk({ blockAt = () => 'minecraft:stone', chests = [], shuffle = false, extra = {} } = {}) {
  const names = Array.from({ length: 4096 }, (_, i) => blockAt(i));
  let palette = [...new Set(names)];
  if (shuffle) palette = palette.reverse();
  const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
  const states = compound({
    palette: list(8, palette.map(string)),
    data: palette.length > 1 ? longs(names.map((n) => palette.indexOf(n)), bits) : null,
  });
  const nbt = compound({
    DataVersion: int(4700),
    Status: string('minecraft:full'),
    sections: list(10, [compound({ Y: int(0, 1), block_states: states })]),
    block_entities: list(10, chests.map(([x, items]) => compound({ id: string('minecraft:chest'), x: int(x), y: int(64), z: int(0), Items: list(10, items.map((id) => compound({ id: string(id), count: int(1) }))), cooking_time_spent: null }))),
    ...extra,
  });
  const body = zlib.deflateSync(nbtedit.serialize({ gzip: false, name: Buffer.alloc(0), root: nbt }));
  const data = Buffer.alloc(5 + body.length);
  data.writeUInt32BE(body.length + 1);
  data[4] = 2;
  body.copy(data, 5);
  return { data, time: 1760000000, external: false };
}

function regionFile(chunks) {
  const all = new Array(1024).fill(null);
  for (const [[cx, cz], c] of chunks) all[region.indexOf(cx, cz)] = c;
  return region.serialize(all);
}

const blocksIn = (file, cx, cz) => {
  const c = region.parse(fs.readFileSync(file))[region.indexOf(cx, cz)];
  if (!c) return null;
  const { root: r } = nbtedit.parse(region.inflate(c));
  return sectionBlocks(nbtedit.get(nbtedit.get(r, 'sections').items[0], 'block_states'));
};

// The world then (in the backup) and now: chunk 0,0 griefed (a hole of 40
// blocks), 1,0 only played in (leaves), 2,0 a chest emptied, 3,0 new since.
const leaves = (d) => (i) => (i < 64 ? `minecraft:oak_leaves[distance=${d},persistent=false]` : 'minecraft:stone');
function setup() {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(MC, DIM, 'region'), { recursive: true });
  fs.mkdirSync(path.join(MC, DIM, 'entities'), { recursive: true });
  fs.mkdirSync(BK, { recursive: true });
  fs.writeFileSync(path.join(MC, 'server.properties'), 'level-name=world\n');
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(src, DIM, 'region'), { recursive: true });
  fs.mkdirSync(path.join(src, DIM, 'entities'), { recursive: true });
  fs.writeFileSync(path.join(src, DIM, 'region', 'r.0.0.mca'), regionFile([
    [[0, 0], chunk()], [[1, 0], chunk({ blockAt: leaves(3) })], [[2, 0], chunk({ chests: [[32, ['minecraft:diamond']]] })],
  ]));
  fs.writeFileSync(path.join(src, DIM, 'entities', 'r.0.0.mca'), regionFile([[[0, 0], chunk({ extra: { Entities: list(10, [compound({ id: string('minecraft:villager') })]) } })]]));
  execFileSync('tar', ['-czf', path.join(BK, BACKUP), '-C', src, 'world']);
  fs.writeFileSync(path.join(MC, DIM, 'region', 'r.0.0.mca'), regionFile([
    [[0, 0], chunk({ blockAt: (i) => (i < 40 ? 'minecraft:air' : 'minecraft:stone'), shuffle: true })],
    [[1, 0], chunk({ blockAt: leaves(1) })],
    [[2, 0], chunk({ chests: [[32, []]] })],
    [[3, 0], chunk({ blockAt: () => 'minecraft:oak_planks' })],
  ]));
  fs.writeFileSync(path.join(MC, DIM, 'entities', 'r.0.0.mca'), regionFile([[[1, 0], chunk()]]));
}

test('region files: parse and serialize keep every chunk as it was', () => {
  const file = regionFile([[[0, 0], chunk()], [[31, 31], chunk({ blockAt: (i) => (i % 2 ? 'minecraft:dirt' : 'minecraft:stone') })]]);
  const back = region.parse(file);
  assert.ok(back[0].data.equals(chunk().data));
  assert.strictEqual(back.filter(Boolean).length, 2);
  assert.ok(region.serialize(back).equals(file));
  assert.deepStrictEqual(region.chunksIn({ x1: -1, z1: 0, x2: 16, z2: 15 }), [[-1, 0], [0, 0], [1, 0]]);
  assert.strictEqual(region.regionOf(-1), -1);
  assert.strictEqual(region.indexOf(-1, -1), 1023);
});

test('compare: real changes count, palette order and nature do not', () => {
  assert.deepStrictEqual(compareChunk(chunk(), chunk()), ['.', 0, 0]);
  assert.deepStrictEqual(compareChunk(chunk({ blockAt: (i) => (i % 3 ? 'minecraft:dirt' : 'minecraft:stone') }), chunk({ blockAt: (i) => (i % 3 ? 'minecraft:dirt' : 'minecraft:stone'), shuffle: true })), ['.', 0, 0], 'same blocks, other palette order');
  assert.deepStrictEqual(compareChunk(chunk({ blockAt: leaves(3) }), chunk({ blockAt: leaves(1) })), ['.', 0, 0], 'leaves count their distance to a log');
  assert.deepStrictEqual(compareChunk(chunk(), chunk({ blockAt: (i) => (i < 40 ? 'minecraft:air' : 'minecraft:stone') })), ['b', 40, 0]);
  assert.deepStrictEqual(compareChunk(chunk(), chunk({ blockAt: (i) => (i < 5 ? 'minecraft:water[level=3]' : 'minecraft:stone') })), ['b', 5, 0], 'flowing water over stone is a change');
  assert.deepStrictEqual(compareChunk(chunk({ blockAt: () => 'minecraft:air' }), chunk({ blockAt: (i) => (i < 5 ? 'minecraft:water[level=3]' : 'minecraft:air') })), ['.', 0, 0], 'flowing water in the air is not');
  assert.deepStrictEqual(compareChunk(chunk({ chests: [[1, ['minecraft:diamond']]] }), chunk({ chests: [[1, []]] })), ['c', 0, 1]);
  assert.deepStrictEqual(compareChunk(null, chunk()), ['n', 0, 0]);
  assert.deepStrictEqual(compareChunk(chunk(), null), ['g', 0, 0]);
  // 300 different blocks: 9 bits each, so indices don't line up with bytes.
  const many = (i) => `minecraft:block_${i % 300}`;
  assert.deepStrictEqual(compareChunk(chunk({ blockAt: many }), chunk({ blockAt: many, shuffle: true })), ['.', 0, 0]);
  assert.strictEqual(compareChunk(chunk({ blockAt: many }), chunk({ blockAt: (i) => (i === 4095 ? 'minecraft:x' : many(i)) }))[1], 1);
});

test('AreaRestore compares an area with a backup', async () => {
  setup();
  const { Backups } = require('../lib/backups');
  const a = new AreaRestore({ mcDir: MC, backupDir: BK, stateDir: process.env.STATE_DIR, backups: new Backups({ backupDir: BK, log: () => {} }), activeWorld: async () => 'world' });
  const q = { backup: BACKUP, dimension: 'overworld', x1: 0, z1: 0, x2: 79, z2: 15 };
  assert.deepStrictEqual(await a.compare(q), { preparing: true });
  await a.queue;
  const r = await a.compare(q);
  assert.strictEqual(r.cells, 'b.cn-');
  assert.deepStrictEqual(r.blocks, [40, 0, 0, 0, 0]);
  assert.deepStrictEqual(r.counts, { same: 1, blocks: 1, contents: 1, added: 1, gone: 0, empty: 1 });
  await assert.rejects(a.compare({ ...q, x2: 1000, z2: 1000 }), /at most 1024/);
  await assert.rejects(a.compare({ ...q, backup: 'other-2026-10-20_21-09-01.tar.gz' }), /backup of other/);
  await assert.rejects(a.compare({ ...q, dimension: 'moon' }), /Invalid dimension/);
});

test('area-restore puts chosen chunks back, keeps the rest, and undoes', async () => {
  setup();
  const file = path.join(MC, DIM, 'region', 'r.0.0.mca');
  const ents = path.join(MC, DIM, 'entities', 'r.0.0.mca');
  const r = await TASKS['area-restore']({ backup: BACKUP, dimension: 'overworld', chunks: [[0, 0], [2, 0], [3, 0]], entities: true });
  assert.strictEqual(r.restored, 2);
  assert.strictEqual(r.skipped, 1, 'chunk 3,0 is not in the backup');
  assert.strictEqual(blocksIn(file, 0, 0), 'minecraft:stone', 'the hole is filled');
  assert.ok(Array.isArray(blocksIn(file, 1, 0)) && blocksIn(file, 1, 0)[0].includes('distance=1'), 'not chosen: as it is now');
  assert.strictEqual(blocksIn(file, 3, 0), 'minecraft:oak_planks', 'not in the backup: stays');
  const chest = region.parse(fs.readFileSync(file))[region.indexOf(2, 0)];
  assert.ok(region.inflate(chest).includes('minecraft:diamond'), 'the chest is full again');
  const e = region.parse(fs.readFileSync(ents));
  assert.ok(region.inflate(e[region.indexOf(0, 0)]).includes('minecraft:villager'), 'entities as in the backup');
  assert.ok(e[region.indexOf(1, 0)], 'entities of other chunks stay');
  assert.ok(fs.existsSync(path.join(BK, '.area-restores', 'world', r.kept, DIM, 'region', 'r.0.0.mca')));

  const u = await TASKS['area-restore']({ undo: r.kept });
  assert.strictEqual(u.restored, 2);
  assert.strictEqual(blocksIn(file, 0, 0).filter((b) => b === 'minecraft:air').length, 40, 'the hole is back');
  assert.ok(!region.inflate(region.parse(fs.readFileSync(file))[region.indexOf(2, 0)]).includes('minecraft:diamond'));
  assert.ok(!region.parse(fs.readFileSync(ents))[region.indexOf(0, 0)], 'no entities there before');
});

test('area-restore: blocks only, and what it refuses', async () => {
  setup();
  const ents = path.join(MC, DIM, 'entities', 'r.0.0.mca');
  const before = fs.readFileSync(ents);
  await TASKS['area-restore']({ backup: BACKUP, dimension: 'overworld', chunks: [[0, 0]], entities: false });
  assert.ok(fs.readFileSync(ents).equals(before), 'entities untouched');
  const go = (args) => TASKS['area-restore']({ backup: BACKUP, dimension: 'overworld', chunks: [[0, 0]], ...args });
  await assert.rejects(go({ backup: '../x.tar.gz' }), /Invalid backup name/);
  await assert.rejects(go({ backup: 'other-2026-10-20_21-09-01.tar.gz' }), /backup of other/);
  await assert.rejects(go({ dimension: 'moon' }), /Invalid dimension/);
  await assert.rejects(go({ chunks: [] }), /Choose the chunks/);
  await assert.rejects(go({ chunks: [[0.5, 0]] }), /Invalid chunk/);
  await assert.rejects(go({ chunks: Array.from({ length: 1025 }, (_, i) => [i, 0]) }), /At most 1024/);
  await assert.rejects(go({ dimension: 'nether' }), /no nether/);
  await assert.rejects(TASKS['area-restore']({ undo: '2020-01-01_00-00-00' }), /gone/);
  await assert.rejects(TASKS['area-restore']({ undo: '../../etc' }), /Invalid restore/);
});

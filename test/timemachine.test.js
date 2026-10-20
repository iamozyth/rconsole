'use strict';
// Time machine: NBT round trips on real Paper 26.3 player files, the
// player-restore helper task, and reading players out of backups.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-tm-'));
const MC = path.join(root, 'mc');
const BK = path.join(root, 'backups');
process.env.MC_DIR = MC;
process.env.BACKUP_DIR = BK;
process.env.STATE_DIR = path.join(root, 'state');

const nbt = require('../lib/nbt');
const nbtedit = require('../lib/nbtedit');
const { TimeMachine, diff, readState } = require('../lib/timemachine');
const { TASKS } = require('../bin/mc-helper');

const UUID = 'b81c4872-63b8-3b59-adc4-f44a1c180ac1';
// Written by Paper 26.3: Lena with oak logs, diamonds, a named enchanted
// pickaxe, a netherite helmet and an elytra in the ender chest; and Lena
// after /clear.
const FULL = fs.readFileSync(path.join(__dirname, 'fixtures', 'player-26.3-full.dat'));
const EMPTY = fs.readFileSync(path.join(__dirname, 'fixtures', 'player-26.3-empty.dat'));
const dataDir = path.join(MC, 'world', 'players', 'data');
const playerFile = path.join(dataDir, `${UUID}.dat`);

function setup() {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(BK, { recursive: true });
  fs.writeFileSync(path.join(MC, 'server.properties'), 'level-name=world\n');
  // Now: cleared, but with level 30 and somewhere else, which a restore must keep.
  const now = nbtedit.parse(EMPTY);
  const lvl = Buffer.alloc(4);
  lvl.writeInt32BE(30);
  nbtedit.set(now.root, 'XpLevel', { type: 3, raw: lvl });
  fs.writeFileSync(playerFile, nbtedit.serialize(now));
  // A backup from when Lena still had everything.
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(src, 'world', 'players', 'data'), { recursive: true });
  fs.mkdirSync(path.join(src, 'world', 'region'), { recursive: true });
  fs.writeFileSync(path.join(src, 'world', 'region', 'r.0.0.mca'), Buffer.alloc(4096));
  fs.writeFileSync(path.join(src, 'world', 'players', 'data', `${UUID}.dat`), FULL);
  fs.writeFileSync(path.join(src, 'world', 'players', 'data', `${UUID}.dat_old`), EMPTY);
  execFileSync('tar', ['-czf', path.join(BK, 'world-2026-10-20_21-09-01.tar.gz'), '-C', src, 'world']);
  execFileSync('tar', ['-czf', path.join(BK, 'other-2026-10-20_21-09-01.tar.gz'), '-C', src, 'world', '--transform=s,^world,other,']);
}

test('nbtedit writes Paper\'s player files back byte for byte', () => {
  for (const f of [FULL, EMPTY]) {
    const t = nbtedit.parse(f);
    assert.ok(t.gzip);
    assert.deepStrictEqual(zlib.gunzipSync(nbtedit.serialize(t)), zlib.gunzipSync(f));
  }
  const t = nbtedit.parse(FULL);
  nbtedit.set(t.root, 'EnderItems', undefined);
  assert.strictEqual(nbtedit.get(t.root, 'EnderItems'), undefined);
  const back = nbt.read(nbtedit.serialize(t));
  assert.strictEqual(back.EnderItems, undefined);
  assert.strictEqual(back.Inventory.length, 3, 'the rest is untouched');
  assert.throws(() => nbtedit.parse(Buffer.from([10, 0, 0, 1, 0, 1, 'x'.charCodeAt(0)])), /unexpected end/);
});

test('readState and diff: what is missing since the backup', () => {
  const then = readState(FULL);
  const now = readState(EMPTY);
  assert.strictEqual(then.hotbar[2].name, 'Old Faithful');
  assert.ok(then.hotbar[2].enchanted);
  assert.strictEqual(then.gear.head.id, 'netherite_helmet');
  assert.strictEqual(then.ender[0].id, 'elytra');
  const flat = (s) => [...s.hotbar, ...s.inventory, ...Object.values(s.gear)];
  const d = diff(flat(then), [...flat(now), { id: 'dirt', count: 5 }, { id: 'diamond', count: 3 }]);
  assert.deepStrictEqual(d.missing.map((x) => [x.id, x.count]), [['oak_log', 64], ['diamond', 20], ['diamond_pickaxe', 1], ['netherite_helmet', 1]]);
  assert.deepStrictEqual(d.gained.map((x) => [x.id, x.count]), [['dirt', 5]]);
  assert.deepStrictEqual(diff(then.ender, now.ender).missing.map((x) => x.id), ['elytra']);
});

test('player-restore puts the inventory back and keeps everything else', async () => {
  setup();
  const r = await TASKS['player-restore']({ uuid: UUID, backup: 'world-2026-10-20_21-09-01.tar.gz', parts: ['inventory'] });
  assert.deepStrictEqual(r.parts, ['inventory']);
  const after = nbt.read(fs.readFileSync(playerFile));
  assert.strictEqual(after.Inventory.length, 3);
  assert.strictEqual(after.equipment.head.id, 'minecraft:netherite_helmet');
  assert.strictEqual(after.XpLevel, 30, 'level stays');
  assert.deepStrictEqual(after.EnderItems, [], 'ender chest not asked for');
  const kept = path.join(BK, '.player-restores', 'world', `${UUID}-${r.kept}.dat`);
  assert.ok(fs.existsSync(kept));

  await TASKS['player-restore']({ uuid: UUID, backup: 'world-2026-10-20_21-09-01.tar.gz', parts: ['ender'] });
  assert.strictEqual(nbt.read(fs.readFileSync(playerFile)).EnderItems[0].id, 'minecraft:elytra');

  // Undo the first one: inventory as it was before.
  await TASKS['player-restore']({ uuid: UUID, undo: r.kept, parts: ['inventory'] });
  const undone = nbt.read(fs.readFileSync(playerFile));
  assert.deepStrictEqual(undone.Inventory, []);
  assert.strictEqual(undone.EnderItems[0].id, 'minecraft:elytra', 'the later ender chest restore stays');
});

test('player-restore refuses what it should', async () => {
  setup();
  const go = (args) => TASKS['player-restore']({ uuid: UUID, parts: ['inventory'], ...args });
  await assert.rejects(go({ uuid: '../x', backup: 'world-2026-10-20_21-09-01.tar.gz' }), /Invalid player id/);
  await assert.rejects(go({ backup: '../world-2026-10-20_21-09-01.tar.gz' }), /Invalid backup name/);
  await assert.rejects(go({ backup: 'other-2026-10-20_21-09-01.tar.gz' }), /backup of other/);
  await assert.rejects(go({ backup: 'world-2026-10-20_21-09-01.tar.gz', parts: ['position'] }), /Nothing to restore/);
  await assert.rejects(go({ uuid: '00000000-0000-0000-0000-000000000000', backup: 'world-2026-10-20_21-09-01.tar.gz' }), /no saved data/);
  await assert.rejects(go({ undo: '2020-01-01_00-00-00' }), /gone/);
  // A link planted where the backup should be is not followed.
  fs.symlinkSync('/etc/passwd', path.join(BK, 'world-2026-10-20_22-00-00.tar.gz'));
  await assert.rejects(go({ backup: 'world-2026-10-20_22-00-00.tar.gz' }));
});

test('TimeMachine reads players out of backups once and compares with now', async () => {
  setup();
  const { Backups } = require('../lib/backups');
  const backups = new Backups({ backupDir: BK, log: () => {} });
  const playerInfo = { playerFile: () => playerFile, live: async () => null };
  const runs = [];
  const tm = new TimeMachine({ backups, backupDir: BK, stateDir: process.env.STATE_DIR, playerInfo, activeWorld: async () => 'world', jobs: { run: async (kind, args) => (runs.push([kind, args]), { ok: true }) } });
  const l = await tm.list(UUID);
  assert.deepStrictEqual(l.backups.map((b) => [b.name, b.indexed]), [['world-2026-10-20_21-09-01.tar.gz', false]]);
  const at = await tm.at(UUID, 'world-2026-10-20_21-09-01.tar.gz', { name: 'Lena' });
  assert.ok(at.found);
  assert.strictEqual(at.then.ender[0].id, 'elytra');
  assert.deepStrictEqual(at.inventory.missing.map((x) => x.id), ['oak_log', 'diamond', 'diamond_pickaxe', 'netherite_helmet']);
  const cache = path.join(process.env.STATE_DIR, 'timemachine', 'world-2026-10-20_21-09-01.tar.gz');
  assert.deepStrictEqual(fs.readdirSync(cache).sort(), ['.done', `${UUID}.dat`], 'only player files, no .dat_old, no regions');
  assert.strictEqual((await tm.list(UUID)).backups[0].has, true);
  assert.strictEqual((await tm.at('00000000-0000-0000-0000-000000000000', 'world-2026-10-20_21-09-01.tar.gz')).found, false);
  await assert.rejects(tm.at(UUID, 'other-2026-10-20_21-09-01.tar.gz'), /backup of other/);
  assert.throws(() => tm.restore(UUID, { backup: 'world-2026-10-20_21-09-01.tar.gz', parts: [] }), /Choose/);
  await tm.restore(UUID, { backup: 'world-2026-10-20_21-09-01.tar.gz', parts: ['inventory', 'bogus'] });
  assert.deepStrictEqual(runs, [['player-restore', { uuid: UUID, backup: 'world-2026-10-20_21-09-01.tar.gz', parts: ['inventory'] }]]);
  // A deleted backup's copy goes.
  fs.rmSync(path.join(BK, 'world-2026-10-20_21-09-01.tar.gz'));
  await tm.list(UUID);
  assert.ok(!fs.existsSync(cache));
});

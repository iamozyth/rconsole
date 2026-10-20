'use strict';
// Unpacking uploaded worlds: the formats people upload, the layouts worlds
// come in, and archives built to escape or exhaust the server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const wi = { ...require('../lib/archive'), ...require('../lib/worldimport') };
const { tar, zip, worldEntries, levelDat } = require('./archives');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-import-'));
const has = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;

// Writes `buf` to a file and unpacks it like the helper does.
async function unpack(buf, opts = {}) {
  const dir = tmp();
  const file = path.join(dir, 'upload.part');
  fs.writeFileSync(file, buf);
  const root = path.join(dir, 'staging');
  fs.mkdirSync(root);
  const fd = fs.openSync(file, 'r');
  try {
    const r = await wi.extract(fd, root, { maxBytes: 1024 ** 3, ...opts });
    return { ...r, root };
  } finally {
    fs.closeSync(fd);
  }
}

test('formats are recognised by their first bytes', () => {
  assert.equal(wi.detect(zip(worldEntries())), 'zip');
  assert.equal(wi.detect(tar(worldEntries())), 'tar');
  assert.equal(wi.detect(zlib.gzipSync(tar(worldEntries()))), 'gzip');
  assert.equal(wi.detect(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0])), 'zstd');
  assert.equal(wi.detect(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])), 'xz');
  assert.equal(wi.detect(Buffer.from('BZh91AY')), 'bzip2');
  assert.equal(wi.detect(Buffer.from('hello world')), null);
  assert.match(wi.explainUnknown(Buffer.from('Rar!\x1a\x07')), /RAR/);
  assert.match(wi.explainUnknown(Buffer.from('7z\xbc\xaf\x27\x1c', 'latin1')), /7-Zip/);
});

test('crc32 matches zlib\'s', () => {
  const buf = Buffer.from('The quick brown fox jumps over the lazy dog');
  assert.equal(wi.crc32(buf), 0x414fa339);
  assert.equal(wi.crc32(buf.subarray(10), wi.crc32(buf.subarray(0, 10))), 0x414fa339);
});

test('a zip of a world folder (26.x layout) unpacks with group-readable modes', async () => {
  const entries = [...worldEntries('MyWorld', { version: '1.21.10' }), { name: '__MACOSX/MyWorld/._level.dat', data: 'junk' }, { name: 'MyWorld/.DS_Store', data: 'junk' }];
  const r = await unpack(zip(entries));
  assert.equal(r.format, 'zip');
  assert.equal(r.files, 8);
  assert.ok(!fs.existsSync(path.join(r.root, '__MACOSX')));
  assert.ok(!fs.existsSync(path.join(r.root, 'MyWorld', '.DS_Store')));
  const found = wi.locate(r.root);
  assert.equal(found.world, 'MyWorld');
  assert.deepEqual(found.dims, { '': 'MyWorld' });
  assert.deepEqual(found.level, { levelName: 'Survival', version: '1.21.10', dataVersion: 4556 });
  const region = path.join(r.root, 'MyWorld', 'dimensions', 'minecraft', 'overworld', 'region');
  assert.equal(fs.statSync(region).mode & 0o777, 0o750);
  assert.equal(fs.statSync(path.join(region, 'r.0.0.mca')).mode & 0o777, 0o640);
  assert.equal(fs.statSync(path.join(region, 'r.0.0.mca')).size, 12288);
});

test('a zip with the world files at the top level (no folder)', async () => {
  const r = await unpack(zip(worldEntries('')));
  const found = wi.locate(r.root);
  assert.equal(found.world, '');
  assert.equal(found.name, null);
});

test('Windows zips: backslashes, no UTF-8 flag, Zip64 records', async () => {
  const entries = worldEntries('Win World').map((e) => ({ ...e, name: e.name.replace(/\//g, '\\') }));
  const r = await unpack(zip(entries, { zip64: true, utf8: false }));
  assert.equal(wi.locate(r.root).world, 'Win World');
  assert.ok(fs.existsSync(path.join(r.root, 'Win World', 'dimensions', 'minecraft', 'the_end', 'region', 'r.0.0.mca')));
});

test('a Bukkit world with _nether and _the_end next to it (tar.gz)', async () => {
  const entries = [
    { name: 'world/level.dat', data: levelDat() },
    { name: 'world/region/r.0.0.mca', data: Buffer.alloc(4096, 1) },
    { name: 'world_nether/level.dat', data: levelDat() },
    { name: 'world_nether/DIM-1/region/r.0.0.mca', data: Buffer.alloc(4096, 2) },
    { name: 'world_the_end/level.dat', data: levelDat() },
    { name: 'world_the_end/DIM1/region/r.0.0.mca', data: Buffer.alloc(4096, 3) },
  ];
  const r = await unpack(zlib.gzipSync(tar(entries)));
  assert.equal(r.format, 'gzip');
  const found = wi.locate(r.root);
  assert.deepEqual(found.dims, { '': 'world', _nether: 'world_nether', _the_end: 'world_the_end' });
});

test('a zip of a whole server folder finds the world in it', async () => {
  const entries = [
    { name: 'server/server.jar', data: 'PK fake' },
    { name: 'server/plugins/Essentials.jar', data: 'PK fake' },
    { name: 'server/logs/latest.log', data: 'log' },
    ...worldEntries('server/world'),
    { name: 'server/world/backups/old/level.dat', data: levelDat() }, // a world inside the world doesn't count
  ];
  const found = wi.locate((await unpack(zip(entries))).root);
  assert.equal(found.world, 'server/world');
  assert.equal(found.name, 'world');
});

test('long names (GNU) and pax headers', async () => {
  const deep = `MyWorld/${'data/'.repeat(25)}x.dat`;
  const r = await unpack(tar([...worldEntries(), { name: deep, data: 'deep' }]));
  assert.equal(fs.readFileSync(path.join(r.root, deep), 'utf8'), 'deep');
});

test('zstd and xz tarballs', async (t) => {
  for (const [cmd, args] of [['zstd', ['-q', '-c']], ['xz', ['-c']]]) {
    if (!has(cmd)) {
      t.diagnostic(`${cmd} not installed`);
      continue;
    }
    const packed = spawnSync(cmd, args, { input: tar(worldEntries()) }).stdout;
    const r = await unpack(packed);
    assert.equal(r.format, cmd);
    assert.equal(wi.locate(r.root).world, 'MyWorld');
  }
});

test('paths that leave the folder refuse the archive', async () => {
  for (const name of ['../evil.sh', 'MyWorld/../../evil', '/etc/cron.d/x', 'C:\\Windows\\x', 'MyWorld\\..\\..\\x']) {
    await assert.rejects(unpack(tar([...worldEntries(), { name, data: 'x' }])), /unsafe path/, name);
    await assert.rejects(unpack(zip([...worldEntries(), { name, data: 'x' }])), /unsafe path/, name);
  }
});

test('links and special files refuse the archive, before anything is written through them', async () => {
  await assert.rejects(unpack(tar([{ name: 'MyWorld/region', type: '2', linkname: '/etc' }, ...worldEntries()])), /links/);
  await assert.rejects(unpack(tar([...worldEntries(), { name: 'MyWorld/hard', type: '1', linkname: 'MyWorld/level.dat' }])), /links/);
  await assert.rejects(unpack(tar([...worldEntries(), { name: 'MyWorld/dev', type: '3' }])), /special files/);
  await assert.rejects(unpack(tar([...worldEntries(), { name: 'MyWorld/fifo', type: '6' }])), /special files/);
  await assert.rejects(unpack(zip([{ name: 'MyWorld/region', data: '/etc', mode: 0o120777 }, ...worldEntries()])), /links/);
});

test('decompression bombs stop at the disk budget', async () => {
  const bomb = zip([...worldEntries(), { name: 'MyWorld/bomb.bin', data: Buffer.alloc(8 * 1024 * 1024) }]);
  assert.ok(bomb.length < 100 * 1024);
  await assert.rejects(unpack(bomb, { maxBytes: 4 * 1024 * 1024 }), /free disk space/);
  // tar: sizes aren't known up front, the writer stops it
  await assert.rejects(unpack(zlib.gzipSync(tar([...worldEntries(), { name: 'MyWorld/bomb.bin', data: Buffer.alloc(8 * 1024 * 1024) }])), { maxBytes: 4 * 1024 * 1024 }), /free disk space/);
  await assert.rejects(unpack(zip(worldEntries()), { maxEntries: 3 }), /more than 3 entries/);
});

test('damaged and incomplete uploads are reported as such', async () => {
  const good = zip(worldEntries());
  await assert.rejects(unpack(good.subarray(0, good.length - 30)), /incomplete|damaged/);
  await assert.rejects(unpack(zip([...worldEntries(), { name: 'MyWorld/x', data: 'hello', badCrc: true }])), /checksum/);
  const t = zlib.gzipSync(tar(worldEntries()));
  await assert.rejects(unpack(t.subarray(0, Math.floor(t.length / 2))), /damaged|incomplete|ends early/);
  await assert.rejects(unpack(tar([...worldEntries(), { name: 'MyWorld/x', data: 'x', badChecksum: true }])), /damaged/);
  await assert.rejects(unpack(zip([...worldEntries(), { name: 'MyWorld/secret', data: 'x', encrypted: true }])), /password/);
  await assert.rejects(unpack(Buffer.from('Rar!\x1a\x07\x00 not a world')), /RAR/);
});

test('archives without exactly one world are refused with what is in them', async () => {
  let r = await unpack(zip([{ name: 'photos/cat.png', data: 'x' }]));
  assert.throws(() => wi.locate(r.root), /No world in the archive/);
  r = await unpack(zip([...worldEntries('a'), ...worldEntries('b')]));
  assert.throws(() => wi.locate(r.root), /2 worlds \(a, b\)/);
  r = await unpack(zip([{ name: 'w/level.dat', data: 'not nbt' }]));
  assert.throws(() => wi.locate(r.root), /not a Minecraft world file/);
});

test('version comparison', () => {
  assert.equal(wi.compareVersions('1.21.4', '1.21.10'), -1);
  assert.equal(wi.compareVersions('26.1', '1.21.10'), 1);
  assert.equal(wi.compareVersions('1.21', '1.21.0'), 0);
  assert.equal(wi.compareVersions('25w41a', '1.21.10'), null);
  assert.equal(wi.compareVersions(null, '1.21.10'), null);
});

'use strict';
// The helper's world-import job against a temporary server folder, with
// archives made by the real tools (zip, GNU tar) as well as by hand.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, spawnSync } = require('child_process');
const { tar, zip, worldEntries, levelDat } = require('./archives');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-import-helper-'));
const MC = path.join(root, 'mc');
const BK = path.join(root, 'backups');
process.env.MC_DIR = MC;
process.env.BACKUP_DIR = BK;
process.env.STATE_DIR = path.join(root, 'state');
fs.mkdirSync(path.join(BK, '.uploads'), { recursive: true });
fs.mkdirSync(path.join(MC, 'world'), { recursive: true });
fs.writeFileSync(path.join(MC, 'world', 'level.dat'), levelDat({ name: 'old' }));
fs.writeFileSync(path.join(MC, 'server.properties'), 'level-name=world\n');

const { TASKS } = require('../bin/mc-helper');
const has = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;

let n = 0;
function upload(buf) {
  const id = (++n).toString(16).padStart(32, '0');
  fs.writeFileSync(path.join(BK, '.uploads', `${id}.part`), buf);
  return id;
}
const leftovers = () => fs.readdirSync(MC).filter((f) => f.startsWith('.'));

// A world folder on disk, as a player would have it.
function worldFolder(dir) {
  for (const e of worldEntries('')) {
    const p = path.join(dir, e.name);
    if (e.name.endsWith('/')) fs.mkdirSync(p, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, e.data);
    }
  }
  return dir;
}

test('imports a zip made by zip -r as a new world', { skip: !has('zip') && 'zip not installed' }, async () => {
  const src = path.join(root, 'src1');
  worldFolder(path.join(src, 'My Survival'));
  execFileSync('zip', ['-qr', path.join(root, 'w.zip'), 'My Survival'], { cwd: src });
  const r = await TASKS['world-import']({ upload: upload(fs.readFileSync(path.join(root, 'w.zip'))), target: 'survival2', replace: false });
  assert.equal(r.world, 'survival2');
  assert.equal(r.from, 'My Survival');
  assert.equal(r.levelName, 'Survival');
  assert.equal(r.version, '1.21.10');
  assert.deepEqual(r.dimensions, ['survival2']);
  assert.ok(fs.existsSync(path.join(MC, 'survival2', 'dimensions', 'minecraft', 'the_nether', 'region', 'r.0.0.mca')));
  assert.equal(fs.statSync(path.join(MC, 'survival2')).mode & 0o777, 0o750);
  assert.deepEqual(leftovers(), []);
});

test('a streamed zip (data descriptors, as Finder and many tools write)', { skip: !has('zip') && 'zip not installed' }, async () => {
  const src = worldFolder(path.join(root, 'src2'));
  const buf = execFileSync('zip', ['-qr', '-', '.'], { cwd: src, maxBuffer: 64 * 1024 * 1024 });
  const r = await TASKS['world-import']({ upload: upload(buf), target: 'streamed', replace: false });
  assert.equal(r.from, null); // files at the top level
  assert.ok(fs.existsSync(path.join(MC, 'streamed', 'level.dat')));
});

test('GNU tar in pax and gnu formats, Bukkit layout, renamed to the target', async () => {
  const src = path.join(root, 'src3');
  worldFolder(path.join(src, 'world'));
  for (const d of ['_nether', '_the_end']) {
    fs.mkdirSync(path.join(src, `world${d}`, d === '_nether' ? 'DIM-1' : 'DIM1', 'region'), { recursive: true });
    fs.writeFileSync(path.join(src, `world${d}`, 'level.dat'), levelDat());
  }
  for (const format of ['pax', 'gnu']) {
    const buf = execFileSync('tar', [`--format=${format}`, '-czf', '-', 'world', 'world_nether', 'world_the_end'], { cwd: src, maxBuffer: 64 * 1024 * 1024 });
    const target = `bukkit-${format}`;
    const r = await TASKS['world-import']({ upload: upload(buf), target, replace: false });
    assert.deepEqual(r.dimensions, [target, `${target}_nether`, `${target}_the_end`]);
    assert.ok(fs.existsSync(path.join(MC, `${target}_nether`, 'DIM-1', 'region')));
  }
});

test('an rconsole backup imports too', async () => {
  const { file } = await TASKS.backup({ world: 'survival2', stamp: '2026-10-20_09-00-00' });
  const r = await TASKS['world-import']({ upload: upload(fs.readFileSync(path.join(BK, file))), target: 'from-backup', replace: false });
  assert.equal(r.from, 'survival2');
});

test('an existing world is not overwritten without replace', async () => {
  await assert.rejects(TASKS['world-import']({ upload: upload(zip(worldEntries())), target: 'world', replace: false }), /already exists/);
  assert.equal(fs.readFileSync(path.join(MC, 'world', 'level.dat')).length > 0, true);
});

test('replace swaps the folders, including a stale nether', async () => {
  fs.mkdirSync(path.join(MC, 'world_nether'));
  fs.writeFileSync(path.join(MC, 'world_nether', 'stale'), 'x');
  const r = await TASKS['world-import']({ upload: upload(zip(worldEntries('NewOne', { name: 'Fresh' }))), target: 'world', replace: true });
  assert.equal(r.replaced, true);
  assert.equal(r.levelName, 'Fresh');
  assert.ok(!fs.existsSync(path.join(MC, 'world_nether')));
  assert.deepEqual(leftovers(), []);
});

test('a bad archive leaves the world as it was and nothing behind', async () => {
  const before = fs.readFileSync(path.join(MC, 'world', 'level.dat'));
  for (const buf of [
    tar([{ name: 'w/region', type: '2', linkname: '/etc' }, ...worldEntries('w')]),
    zip([...worldEntries('w'), { name: '../escape', data: 'x' }]),
    zip([{ name: 'readme.txt', data: 'no world here' }]),
    zlib.gzipSync(tar(worldEntries('w'))).subarray(0, 200),
  ]) {
    await assert.rejects(TASKS['world-import']({ upload: upload(buf), target: 'world', replace: true }));
    assert.deepEqual(fs.readFileSync(path.join(MC, 'world', 'level.dat')), before);
    assert.deepEqual(leftovers(), []);
  }
  assert.ok(!fs.existsSync(path.join(root, 'escape')) && !fs.existsSync(path.join(MC, 'escape')));
});

test('upload ids, world names and missing uploads are checked here too', async () => {
  await assert.rejects(TASKS['world-import']({ upload: '../../etc/passwd', target: 'x', replace: false }), /Invalid upload/);
  await assert.rejects(TASKS['world-import']({ upload: upload(zip(worldEntries())), target: '../x', replace: false }), /Invalid world name/);
  await assert.rejects(TASKS['world-import']({ upload: 'f'.repeat(32), target: 'x', replace: false }), /upload is gone/);
  // A link planted in place of the upload is not followed.
  const id = 'e'.repeat(32);
  fs.symlinkSync(path.join(MC, 'server.properties'), path.join(BK, '.uploads', `${id}.part`));
  await assert.rejects(TASKS['world-import']({ upload: id, target: 'x', replace: false }), /upload is gone/);
});

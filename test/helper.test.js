'use strict';
// Exercises the privileged helper's tasks against a temporary server dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-helper-'));
const MC = path.join(root, 'mc');
const BK = path.join(root, 'backups');
process.env.MC_DIR = MC;
process.env.BACKUP_DIR = BK;
process.env.STATE_DIR = path.join(root, 'state');

function world(name, marker) {
  for (const d of ['', '_nether']) {
    fs.mkdirSync(path.join(MC, name + d, 'region'), { recursive: true });
    fs.writeFileSync(path.join(MC, name + d, 'level.dat'), `${marker}${d}`);
  }
}
fs.mkdirSync(BK, { recursive: true });
world('world', 'A');
fs.writeFileSync(path.join(MC, 'server.properties'), '#c\nlevel-name=world\nrcon.password=x\nmotd=hi\n');

const { TASKS, pruneResults } = require('../bin/mc-helper');
const read = (p) => fs.readFileSync(path.join(MC, p), 'utf8');

test('backup names the archive after the world', async () => {
  const r = await TASKS.backup({ stamp: '2026-10-11_04-00-00' });
  assert.equal(r.file, 'world-2026-10-11_04-00-00.tar.gz');
  assert.deepEqual(r.dirs, ['world', 'world_nether']);
});

test('restore as a new world renames all dimensions', async () => {
  const r = await TASKS.restore({ file: 'world-2026-10-11_04-00-00.tar.gz', target: 'copy', replace: false });
  assert.equal(r.from, 'world');
  assert.equal(read('copy/level.dat'), 'A');
  assert.equal(read('copy_nether/level.dat'), 'A_nether');
});

test('restore refuses to overwrite without replace', async () => {
  await assert.rejects(TASKS.restore({ file: 'world-2026-10-11_04-00-00.tar.gz', target: 'copy', replace: false }), /already exists/);
});

test('restore with replace swaps the world contents', async () => {
  fs.writeFileSync(path.join(MC, 'world/level.dat'), 'CHANGED');
  await TASKS.restore({ file: 'world-2026-10-11_04-00-00.tar.gz', target: 'world', replace: true });
  assert.equal(read('world/level.dat'), 'A');
  assert.ok(!fs.readdirSync(MC).some((f) => f.startsWith('.restore-old')));
});

test('restore rejects archives with symlinks', async () => {
  const evil = path.join(root, 'evil');
  fs.mkdirSync(path.join(evil, 'world'), { recursive: true });
  fs.symlinkSync('/etc/passwd', path.join(evil, 'world', 'level.dat'));
  execFileSync('tar', ['-czf', path.join(BK, 'world-2026-01-01_00-00-00.tar.gz'), '-C', evil, 'world']);
  const before = read('world/level.dat');
  await assert.rejects(TASKS.restore({ file: 'world-2026-01-01_00-00-00.tar.gz', target: 'world', replace: true }), /links/);
  assert.equal(read('world/level.dat'), before);
});

test('restore rejects archives with foreign top-level folders', async () => {
  const evil = path.join(root, 'evil2');
  fs.mkdirSync(path.join(evil, 'world'), { recursive: true });
  fs.mkdirSync(path.join(evil, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(evil, 'plugins', 'x.jar'), 'x');
  execFileSync('tar', ['-czf', path.join(BK, 'world-2026-01-02_00-00-00.tar.gz'), '-C', evil, 'world', 'plugins']);
  await assert.rejects(TASKS.restore({ file: 'world-2026-01-02_00-00-00.tar.gz', target: 'other', replace: false }), /exactly one world/);
  assert.ok(!fs.existsSync(path.join(MC, 'plugins')));
});

test('restore rejects path traversal names', async () => {
  await assert.rejects(TASKS.restore({ file: '../etc-2026-01-01_00-00-00.tar.gz', target: 'x' }), /Invalid backup name/);
  await assert.rejects(TASKS.restore({ file: 'world-2026-10-11_04-00-00.tar.gz', target: '../x' }), /Invalid world name/);
});

test('active world cannot be deleted; others are archived then removed', async () => {
  await assert.rejects(TASKS['world-delete']({ world: 'world', archive: true }), /active world/);
  const r = await TASKS['world-delete']({ world: 'copy', archive: true });
  assert.match(r.archived, /^copy-\d{4}-/);
  assert.ok(!fs.existsSync(path.join(MC, 'copy')));
  assert.ok(fs.existsSync(path.join(BK, r.archived)));
});

test('properties: editable keys pass, protected keys are refused', async () => {
  await TASKS.properties({ set: { motd: 'Hello: world', difficulty: 'hard' } });
  assert.match(read('server.properties'), /^motd=Hello\\: world$/m);
  assert.match(read('server.properties'), /^#c$/m);
  await assert.rejects(TASKS.properties({ set: { 'rcon.password': 'pwned' } }), /can't be changed/);
  await assert.rejects(TASKS.properties({ set: { 'level-name': 'x' } }), /can't be changed/);
  await assert.rejects(TASKS.properties({ set: { 'max-players': '0' } }), /between/);
  await TASKS.properties({ world: true, set: { 'level-name': 'copy2', 'level-type': 'minecraft:flat' } });
  assert.match(read('server.properties'), /^level-type=minecraft\\:flat$/m);
  assert.match(read('server.properties'), /^rcon.password=x$/m);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('old job results are pruned, except the newest server update', () => {
  const jobs = path.join(BK, '.jobs');
  fs.mkdirSync(jobs, { recursive: true });
  const old = (Date.now() - 40 * 86400 * 1000) / 1000;
  const put = (name, data, age) => {
    fs.writeFileSync(path.join(jobs, name), JSON.stringify(data));
    if (age) fs.utimesSync(path.join(jobs, name), age, age);
  };
  put('a.json', { ok: true, kind: 'backup' }, old);
  put('b.json', { ok: true, kind: 'paper-update', version: '1.21.4', build: 100 }, old - 10);
  put('c.json', { ok: true, kind: 'paper-update', version: '1.21.3', build: 90 }, old - 20);
  put('d.json', { ok: true, kind: 'backup' });
  fs.symlinkSync('/etc/hostname', path.join(jobs, 'e.json'));
  pruneResults();
  assert.deepStrictEqual(fs.readdirSync(jobs).sort(), ['b.json', 'd.json', 'e.json']);
});

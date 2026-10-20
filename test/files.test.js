'use strict';
// Server → Files: listing and reading (rconsole) and the helper's changes,
// against a temporary server folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-files-'));
const MC = path.join(root, 'mc');
const BK = path.join(root, 'backups');
process.env.MC_DIR = MC;
process.env.BACKUP_DIR = BK;
process.env.STATE_DIR = path.join(root, 'state');
fs.mkdirSync(path.join(BK, '.uploads-files'), { recursive: true });
fs.mkdirSync(path.join(MC, 'plugins', 'Essentials'), { recursive: true });
fs.mkdirSync(path.join(MC, 'world', 'region'), { recursive: true });
fs.writeFileSync(path.join(MC, 'world', 'region', 'r.0.0.mca'), Buffer.from([0, 1, 2, 0, 255]));
fs.writeFileSync(path.join(MC, 'server.properties'), 'level-name=world\nenable-rcon=true\nrcon.port=25575\nrcon.password=s3cret\nmotd=Hi\n');
fs.writeFileSync(path.join(MC, 'plugins', 'Essentials', 'config.yml'), 'a: 1\n');
fs.writeFileSync(path.join(MC, 'instance.json'), '{}');
fs.mkdirSync(path.join(MC, '.rconsole-previous'));
fs.symlinkSync('/etc', path.join(MC, 'etc-link'));

const { Files, parts, sha256 } = require('../lib/files');
const { TASKS } = require('../bin/mc-helper');
const { zip } = require('./archives');

const files = new Files({ mcDir: MC });
const op = (args) => TASKS['file-op'](args);
const read = (rel) => fs.readFileSync(path.join(MC, rel), 'utf8');

test('paths: no way out of the server folder, rconsole\'s own files are read only', () => {
  assert.deepStrictEqual(parts('plugins/Essentials/config.yml'), ['plugins', 'Essentials', 'config.yml']);
  assert.deepStrictEqual(parts(''), []);
  for (const bad of ['../etc/passwd', 'plugins/../../x', 'a\\b', 'a\0b', 'a/./b']) assert.throws(() => parts(bad), /Invalid/);
  assert.throws(() => parts('instance.json', { write: true }), /belongs to rconsole/);
  assert.throws(() => parts('.rconsole-previous/x', { write: true }), /rconsole's own/);
  assert.throws(() => parts('', { write: true }), /itself/);
  assert.doesNotThrow(() => parts('plugins/instance.json', { write: true }));
});

test('list: folders first, links shown but not followed, rconsole folders hidden', () => {
  const r = files.list('');
  assert.deepStrictEqual(r.entries.map((e) => [e.name, e.type]), [['plugins', 'dir'], ['world', 'dir'], ['etc-link', 'link'], ['instance.json', 'file'], ['server.properties', 'file']]);
  assert.ok(r.entries.find((e) => e.name === 'server.properties').editable);
  assert.throws(() => files.list('etc-link'), /is a link/);
  assert.throws(() => files.list('nope'), /doesn't exist/);
});

test('read: text with its hash, binary files as what they are', () => {
  const f = files.read('plugins/Essentials/config.yml');
  assert.strictEqual(f.content, 'a: 1\n');
  assert.strictEqual(f.sha256, sha256(Buffer.from('a: 1\n')));
  assert.strictEqual(f.protected, null);
  const bin = files.read('world/region/r.0.0.mca');
  assert.strictEqual(bin.content, null);
  assert.strictEqual(bin.reason, 'binary');
  assert.match(files.read('instance.json').protected, /belongs to rconsole/);
  assert.throws(() => files.read('etc-link/passwd'), /is a link/);
});

test('write: only over the version that was opened, previous kept, revert swaps', async () => {
  const f = files.read('plugins/Essentials/config.yml');
  await assert.rejects(op({ op: 'write', path: f.path, content: 'a: 2\n', expected: sha256(Buffer.from('other')) }), /changed since you opened it/);
  await op({ op: 'write', path: f.path, content: 'a: 2\n', expected: f.sha256 });
  assert.strictEqual(read(f.path), 'a: 2\n');
  assert.ok(files.read(f.path).hasPrevious);
  await op({ op: 'revert', path: f.path });
  assert.strictEqual(read(f.path), 'a: 1\n');
  await op({ op: 'revert', path: f.path });
  assert.strictEqual(read(f.path), 'a: 2\n');
  // New files: only when nothing is there.
  await op({ op: 'write', path: 'plugins/Essentials/new.yml', content: 'x: y\n', expected: null });
  await assert.rejects(op({ op: 'write', path: 'plugins/Essentials/new.yml', content: 'z\n', expected: null }), /changed since you opened it/);
  await assert.rejects(op({ op: 'write', path: 'etc-link/evil', content: 'x', expected: null }), /is a link/);
  await assert.rejects(op({ op: 'write', path: 'instance.json', content: '{}', expected: null }), /belongs to rconsole/);
});

test('server.properties: rconsole\'s RCON settings survive any edit', async () => {
  const f = files.read('server.properties');
  await op({ op: 'write', path: 'server.properties', content: 'level-name=world\nenable-rcon=false\nrcon.password=\nmotd=Changed\n', expected: f.sha256 });
  const now = read('server.properties');
  assert.match(now, /^motd=Changed$/m);
  assert.match(now, /^enable-rcon=true$/m);
  assert.match(now, /^rcon\.password=s3cret$/m);
  assert.match(now, /^rcon\.port=25575$/m);
});

test('folders, moves and deletes: the active world is off limits, deletes are archived', async () => {
  await op({ op: 'mkdir', path: 'plugins/New' });
  await assert.rejects(op({ op: 'mkdir', path: 'plugins/New' }), /already exists/);
  await op({ op: 'move', from: 'plugins/Essentials/new.yml', to: 'plugins/New/moved.yml' });
  assert.strictEqual(read('plugins/New/moved.yml'), 'x: y\n');
  await assert.rejects(op({ op: 'move', from: 'plugins', to: 'plugins/inside' }), /into itself/);
  await assert.rejects(op({ op: 'move', from: 'world', to: 'old-world' }), /active world/);
  await assert.rejects(op({ op: 'delete', path: 'world' }), /active world/);
  await assert.rejects(op({ op: 'move', from: 'plugins/New', to: 'etc-link/New' }), /is a link/);
  const r = await op({ op: 'delete', path: 'plugins/New' });
  assert.ok(!fs.existsSync(path.join(MC, 'plugins', 'New')));
  assert.match(r.archived, /^deleted-files\/New-.*\.tar\.gz$/);
  assert.match(execFileSync('tar', ['-tzf', path.join(BK, r.archived)], { encoding: 'utf8' }), /New\/moved\.yml/);
  assert.deepStrictEqual(fs.readdirSync(path.join(MC, 'plugins')).filter((n) => n.startsWith('.')), []);
});

test('uploads: placed as a file or unpacked into a new folder, never over something', async () => {
  const up = (id, buf) => {
    fs.writeFileSync(path.join(BK, '.uploads-files', `${id}.part`), buf);
    return id;
  };
  await op({ op: 'place', upload: up('a'.repeat(32), 'jar bytes'), dir: 'plugins', name: 'Thing.jar' });
  assert.strictEqual(read('plugins/Thing.jar'), 'jar bytes');
  await assert.rejects(op({ op: 'place', upload: up('b'.repeat(32), 'again'), dir: 'plugins', name: 'Thing.jar' }), /already exists/);
  await assert.rejects(op({ op: 'place', upload: 'b'.repeat(32), dir: 'plugins', name: '../x' }), /Invalid/);
  const z = zip([{ name: 'pack/pack.mcmeta', data: '{}' }, { name: 'pack/assets/x.txt', data: 'hi' }]);
  const r = await op({ op: 'place', upload: up('c'.repeat(32), z), dir: '', name: 'resourcepack', unpack: true });
  assert.strictEqual(r.files, 2);
  assert.strictEqual(read('resourcepack/pack/assets/x.txt'), 'hi');
  const evil = zip([{ name: '../../escape.txt', data: 'x' }]);
  await assert.rejects(op({ op: 'place', upload: up('d'.repeat(32), evil), dir: '', name: 'evil', unpack: true }), /unsafe path/);
  assert.ok(!fs.existsSync(path.join(MC, 'evil')));
  assert.deepStrictEqual(fs.readdirSync(MC).filter((n) => n.startsWith('.rconsole-upload')), []);
});

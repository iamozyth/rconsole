'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-configs-'));
const MC = path.join(root, 'mc');
process.env.MC_DIR = MC;
process.env.BACKUP_DIR = path.join(root, 'backups');
process.env.STATE_DIR = path.join(root, 'state');
fs.mkdirSync(path.join(MC, 'config'), { recursive: true });
fs.writeFileSync(path.join(MC, 'config', 'paper-global.yml'), '_version: 30\n'); // a Paper server: configs under plugins/
fs.mkdirSync(path.join(MC, 'plugins', 'Essentials'), { recursive: true });
fs.writeFileSync(path.join(MC, 'plugins', 'Essentials', 'config.yml'), 'motd: hi\nspawn:\n  delay: 3\n', { mode: 0o640 });
fs.writeFileSync(path.join(MC, 'plugins', 'Essentials', 'data.json'), '{"a":1}');
fs.writeFileSync(path.join(MC, 'plugins', 'Essentials', 'secret.db'), 'binary');
fs.writeFileSync(path.join(root, 'outside.yml'), 'not yours\n');
fs.symlinkSync(path.join(root, 'outside.yml'), path.join(MC, 'plugins', 'Essentials', 'link.yml'));

const { TASKS } = require('../bin/mc-helper');
const { Configs, validate } = require('../lib/configs');

test('configs: list and read under plugins/, text files only, no links', () => {
  const c = new Configs({ mcDir: MC });
  const { root: r, groups } = c.list();
  assert.strictEqual(r, 'plugins');
  assert.deepStrictEqual(groups.map((g) => [g.name, g.files.map((f) => f.path)]), [['Essentials', ['plugins/Essentials/config.yml', 'plugins/Essentials/data.json']]]);
  assert.strictEqual(c.read('plugins/Essentials/config.yml').content, 'motd: hi\nspawn:\n  delay: 3\n');
  assert.throws(() => c.read('plugins/Essentials/link.yml'), /Links/);
  assert.throws(() => c.read('plugins/../server.properties'), /Invalid file name/);
  assert.throws(() => c.read('config/paper-global.yml'), /under plugins\//);
  assert.throws(() => c.read('plugins/Essentials/secret.db'), /can be edited/);
});

test('configs: the helper writes atomically, keeps the previous version, reverts', async () => {
  const file = 'plugins/Essentials/config.yml';
  const r = await TASKS['config-write']({ file, content: 'motd: hello\nspawn:\n  delay: 5\n' });
  assert.strictEqual(r.file, file);
  assert.strictEqual(fs.readFileSync(path.join(MC, file), 'utf8'), 'motd: hello\nspawn:\n  delay: 5\n');
  assert.strictEqual(fs.statSync(path.join(MC, file)).mode & 0o777, 0o640);
  assert.strictEqual(fs.readFileSync(path.join(MC, 'plugins/.rconsole-previous/Essentials/config.yml'), 'utf8'), 'motd: hi\nspawn:\n  delay: 3\n');
  assert.ok(new Configs({ mcDir: MC }).read(file).hasPrevious);
  await TASKS['config-write']({ file, revert: true });
  assert.strictEqual(fs.readFileSync(path.join(MC, file), 'utf8'), 'motd: hi\nspawn:\n  delay: 3\n');

  await assert.rejects(TASKS['config-write']({ file: 'plugins/Essentials/link.yml', content: 'x: 1\n' }), /Links/);
  assert.strictEqual(fs.readFileSync(path.join(root, 'outside.yml'), 'utf8'), 'not yours\n');
  await assert.rejects(TASKS['config-write']({ file: 'plugins/../../outside.yml', content: 'x' }), /Invalid file name/);
  await assert.rejects(TASKS['config-write']({ file, content: 'a:\n\tb: 1\n' }), /tabs \(line 2\)/);
  await assert.rejects(TASKS['config-write']({ file: 'plugins/Essentials/data.json', content: '{bad' }), /Invalid JSON/);
  await assert.rejects(TASKS['config-write']({ file: 'plugins/Essentials/new.yml', content: 'x: 1\n' }), /not found/);
  assert.strictEqual(validate('a.yml', 'ok: 1\n'), null);
});

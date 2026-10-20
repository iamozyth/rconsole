'use strict';

// bin/self-update.sh and bin/node.sh: the Node.js a version needs is
// installed before rconsole restarts, also when there are no new commits
// (the update to 4.7 ran with the old script), and a version whose Node.js
// can't be installed is rolled back. systemctl, sleep and NodeSource are
// stubs; git runs for real against a local origin.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { SelfUpdate } = require('../lib/selfupdate');

const ROOT = path.join(__dirname, '..');
const sh = (cmd, opts = {}) => execFileSync('bash', ['-c', cmd], { encoding: 'utf8', ...opts }).trim();

test('node.sh reads engines.node without running node', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-node-'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "engines": { "node": ">= 26" } }');
  assert.strictEqual(sh(`. bin/node.sh; node_required ${dir}`, { cwd: ROOT }), '26');
  assert.strictEqual(sh(`. bin/node.sh; node_required ${ROOT}`, { cwd: ROOT }), String(require('../package.json').engines.node.match(/\d+/)[0]));
  assert.strictEqual(sh(`. bin/node.sh; node_major ${process.execPath}`, { cwd: ROOT }), process.versions.node.split('.')[0]);
  assert.strictEqual(sh('. bin/node.sh; node_major /nonexistent/node', { cwd: ROOT }), '0');
});

test('SelfUpdate.node() compares the running Node.js with engines.node', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-node-'));
  const node = (range) => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ engines: { node: range } }));
    return new SelfUpdate({ dir, stateDir: dir }).node();
  };
  assert.deepStrictEqual(node('>=999'), { version: process.version, need: 999, ok: false });
  assert.strictEqual(node('>=1').ok, true);
});

// A checkout cloned from a local origin, with stub commands on PATH and a
// stub bin/node.sh: node_major reads $FAKE/version, install_nodesource
// writes the major into it (or fails with FAIL_INSTALL=1).
function setup({ have, need = 24 }) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-su-'));
  const fake = path.join(t, 'fake');
  const origin = path.join(t, 'origin');
  const dir = path.join(t, 'opt');
  fs.mkdirSync(fake);
  fs.writeFileSync(path.join(fake, 'version'), String(have));
  fs.writeFileSync(path.join(fake, 'systemctl'), `#!/bin/bash\necho "$*" >> ${fake}/systemctl.log\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(fake, 'sleep'), '#!/bin/bash\n', { mode: 0o755 });
  fs.writeFileSync(path.join(fake, 'node'), `#!/bin/bash\nv="$(cat ${fake}/version)"\ncase "$1" in -v) echo "v$v.0.0" ;; -p) echo "$v" ;; *) exec ${process.execPath} "$@" ;; esac\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(origin, 'bin'), { recursive: true });
  for (const f of ['units.sh', 'self-update.sh']) fs.copyFileSync(path.join(ROOT, 'bin', f), path.join(origin, 'bin', f));
  const real = fs.readFileSync(path.join(ROOT, 'bin', 'node.sh'), 'utf8');
  const stub = real.replace(/^install_nodesource\(\) \{[\s\S]*?^\}\n/m, `install_nodesource() {\n  [ "\${FAIL_INSTALL:-0}" = 0 ] || { echo "node: apt-get update failed" >&2; return 1; }\n  echo "$1" > ${fake}/version\n}\n`)
    .replace(/^NODESOURCE_BIN=.*$/m, `NODESOURCE_BIN=${fake}/node`);
  assert.notStrictEqual(stub, real);
  fs.writeFileSync(path.join(origin, 'bin', 'node.sh'), stub);
  fs.writeFileSync(path.join(origin, 'package.json'), JSON.stringify({ version: '1.0.0', engines: { node: `>=${need}` } }));
  fs.writeFileSync(path.join(origin, 'server.js'), '');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'one');
  execFileSync('git', ['clone', '-q', origin, dir]);
  const env = path.join(t, 'rconsole.env');
  fs.writeFileSync(env, `NODE_BIN=${fake}/node\n`);
  const run = (extra = {}) => {
    const r = spawnSync('bash', [path.join(dir, 'bin', 'self-update.sh')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, RCONSOLE_DIR: dir, RCONSOLE_ENV: env, STATUS_DIR: path.join(t, 'status'), SYSTEMD_DIR: path.join(t, 'units'), POLKIT_DIR: path.join(t, 'polkit'), ...extra },
    });
    const status = JSON.parse(fs.readFileSync(path.join(t, 'status', 'self-update.json'), 'utf8'));
    const calls = fs.existsSync(path.join(fake, 'systemctl.log')) ? fs.readFileSync(path.join(fake, 'systemctl.log'), 'utf8') : '';
    return { code: r.status, status, calls, out: r.stdout + r.stderr };
  };
  const head = () => git(dir, 'rev-parse', 'HEAD').trim();
  return { t, fake, origin, dir, env, run, git, head };
}

test('self-update: up to date but Node.js too old installs it and restarts', () => {
  const s = setup({ have: 20 });
  const r = s.run();
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.status.state, 'done');
  assert.match(r.status.message, /Installed Node\.js v24\.0\.0; rconsole is up to date/);
  assert.deepStrictEqual(r.status.installed, ['Node.js v24.0.0 from NodeSource']);
  assert.match(r.calls, /^restart rconsole\.service$/m);
  // Once it's there, nothing to do.
  fs.writeFileSync(path.join(s.fake, 'systemctl.log'), '');
  const again = s.run();
  assert.strictEqual(again.status.message, 'Already up to date');
  assert.doesNotMatch(again.calls, /restart/);
});

test('self-update: Node.js that can\'t be installed rolls a new version back', () => {
  const s = setup({ have: 24 });
  const before = s.head();
  fs.writeFileSync(path.join(s.origin, 'package.json'), JSON.stringify({ version: '2.0.0', engines: { node: '>=26' } }));
  s.git(s.origin, 'commit', '-qam', 'two');
  const r = s.run({ FAIL_INSTALL: '1' });
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual(r.status.state, 'failed');
  assert.match(r.status.message, /needs Node\.js 26; installing it from NodeSource failed: node: apt-get update failed; stayed on the old version/);
  assert.strictEqual(s.head(), before);
  assert.doesNotMatch(r.calls, /restart/);
});

test('self-update: a too old NODE_BIN that isn\'t NodeSource\'s is reported, not replaced', () => {
  const s = setup({ have: 20 });
  fs.writeFileSync(s.env, `NODE_BIN=${process.execPath}-not-there\n`);
  const r = s.run();
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.status.message, /needs Node\.js 24 but .*-not-there is v0; install a newer one there/);
  assert.strictEqual(fs.readFileSync(path.join(s.fake, 'version'), 'utf8'), '20');
});

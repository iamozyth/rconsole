'use strict';
// The unit files: what the helper jobs and the servers may see.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const unit = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const values = (text, key) => text.split('\n').filter((l) => l.startsWith(`${key}=`)).flatMap((l) => l.slice(key.length + 1).split(/\s+/)).filter(Boolean);

// Every environment variable rconsole reads that holds a secret.
function secretNames() {
  const files = ['server.js', ...fs.readdirSync(path.join(ROOT, 'lib')).map((f) => `lib/${f}`)].filter((f) => f.endsWith('.js'));
  const names = new Set();
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of text.matchAll(/env(?:\.|\[')([A-Z][A-Z0-9_]+)|secret\('([A-Z][A-Z0-9_]+)'\)/g)) names.add(m[1] || m[2]);
  }
  return [...names].filter((n) => /PASSWORD|SECRET|TOKEN|PASSPHRASE|ACCESS_KEY/.test(n) && !/_FILE$/.test(n));
}

test('helper jobs run without any of rconsole\'s secrets in their environment', () => {
  const secrets = secretNames();
  assert.ok(secrets.includes('RCON_PASSWORD') && secrets.includes('OIDC_CLIENT_SECRET'), secrets.join(' '));
  for (const name of ['rconsole-job@.service', 'rconsole-net@.service']) {
    const unset = values(unit(name), 'UnsetEnvironment');
    for (const s of secrets) assert.ok(unset.includes(s), `${name} must unset ${s}`);
  }
});

test('servers see only their own folder and never the env file', () => {
  const mc = unit('rconsole-mc@.service');
  assert.doesNotMatch(mc, /^EnvironmentFile=\/etc/m);
  assert.deepStrictEqual(values(mc, 'TemporaryFileSystem'), ['/srv/minecraft-servers:ro']);
  assert.deepStrictEqual(values(mc, 'BindPaths'), ['/srv/minecraft-servers/%i']);
  assert.deepStrictEqual(values(mc, 'ReadOnlyPaths'), ['-/srv/minecraft-servers/%i/instance.json']);
  assert.deepStrictEqual(values(mc, 'InaccessiblePaths'), ['-/srv/minecraft', '-/srv/minecraft-backups']);
  assert.deepStrictEqual(values(mc, 'OOMScoreAdjust'), ['500']);
  assert.ok(mc.split('[Service]')[0].includes('StartLimitBurst='), 'start limit belongs in [Unit]');
});

test('render_unit keeps the hidden folders apart from the servers folder', () => {
  const render = (env) => execFileSync('bash', ['-c', `source ${ROOT}/bin/units.sh && render_unit < ${ROOT}/rconsole-mc@.service`], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  assert.deepStrictEqual(values(render({ MC_DIR: '/data/mc', SERVERS_DIR: '/data/servers', BACKUP_DIR: '/data/bk' }), 'InaccessiblePaths'), ['-/data/mc', '-/data/bk']);
  // Servers inside MC_DIR: hiding MC_DIR would hide the server itself.
  const nested = render({ MC_DIR: '/srv/mc', SERVERS_DIR: '/srv/mc/servers', BACKUP_DIR: '/srv/bk' });
  assert.deepStrictEqual(values(nested, 'InaccessiblePaths'), ['-/srv/bk']);
  assert.deepStrictEqual(values(nested, 'BindPaths'), ['/srv/mc/servers/%i']);
});

test('polkit lets rconsole start the limits helper and clear a crash loop, nothing more', () => {
  const rules = unit('50-rconsole.rules');
  const allow = (u, verb, user = 'rconsole') => {
    let result = null;
    const polkit = { Result: { YES: 'yes' }, addRule: (fn) => (result = fn({ id: 'org.freedesktop.systemd1.manage-units', lookup: (k) => ({ unit: u, verb })[k] }, { user })) };
    new Function('polkit', rules)(polkit);
    return result === 'yes';
  };
  assert.ok(allow('rconsole-limits.service', 'start'));
  assert.ok(!allow('rconsole-limits.service', 'stop'));
  assert.ok(allow('rconsole-mc@survival.service', 'reset-failed'));
  assert.ok(!allow('sshd.service', 'reset-failed'));
  assert.ok(!allow('rconsole-limits.service', 'start', 'minecraft'));
});

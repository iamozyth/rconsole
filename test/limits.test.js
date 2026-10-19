'use strict';
// bin/mc-limits.js: per-server drop-ins and the RCON firewall, built from
// instance.json (it runs as root).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rconsole-limits-'));
const MC = path.join(root, 'mc');
process.env.MC_DIR = MC;
process.env.SERVERS_DIR = path.join(root, 'servers');
process.env.WEB_PORT = '8080';
process.env.RCON_HOST = '127.0.0.1';
const limits = require('../bin/mc-limits');
const instances = require('../lib/instances');

const base = { id: 'survival', distribution: 'paper', version: '26.3', build: 1, java: 25, memoryMb: 4096, port: 25565, launch: { type: 'jar', path: 'p.jar' } };

test('drop-in: MemoryMax always, SocketBind rules only with the port lock', () => {
  const plain = limits.dropin(instances.validate(base), 25576);
  assert.match(plain, /^MemoryMax=6144M$/m);
  assert.doesNotMatch(plain, /SocketBind/);
  const locked = limits.dropin(instances.validate({ ...base, portLock: true, extraPorts: [8100, 25565] }), 25576);
  assert.deepStrictEqual(locked.match(/^SocketBind.*$/gm), ['SocketBindAllow=tcp:25565', 'SocketBindAllow=tcp:25576', 'SocketBindAllow=8100', 'SocketBindDeny=any']);
});

test('writeDropins writes what changed and removes those of deleted servers', () => {
  const unitDir = fs.mkdtempSync(path.join(root, 'units-'));
  const s = (i) => ({ i: instances.validate(i), rconPort: 25576 });
  assert.strictEqual(limits.writeDropins([s(base), s({ ...base, id: 'creative' })], unitDir), true);
  assert.ok(fs.existsSync(path.join(unitDir, 'rconsole-mc@creative.service.d', '50-rconsole-limits.conf')));
  assert.strictEqual(limits.writeDropins([s(base), s({ ...base, id: 'creative' })], unitDir), false);
  // An admin's own drop-in next to ours is left alone.
  fs.writeFileSync(path.join(unitDir, 'rconsole-mc@creative.service.d', 'mine.conf'), '[Service]\n');
  assert.strictEqual(limits.writeDropins([s(base)], unitDir), true);
  assert.ok(!fs.existsSync(path.join(unitDir, 'rconsole-mc@creative.service.d', '50-rconsole-limits.conf')));
  assert.ok(fs.existsSync(path.join(unitDir, 'rconsole-mc@creative.service.d', 'mine.conf')));
});

test('rconPorts: every RCON port, never a game port or the web port', () => {
  fs.mkdirSync(MC, { recursive: true });
  fs.writeFileSync(path.join(MC, 'server.properties'), 'server-port=25600\nrcon.port=25575\n');
  const s = (id, port, rconPort) => ({ i: instances.validate({ ...base, id, port }), rconPort });
  // creative plays on 25577; a server whose RCON claims it can't close it.
  const ports = limits.rconPorts([s('survival', 25565, 25576), s('creative', 25577, 25578), s('odd', 25579, 25577), s('web', 25580, 8080)]);
  assert.deepStrictEqual(ports, [25575, 25576, 25578]);
});

test('nftScript: one table, replaced atomically; empty when nothing to close', () => {
  const script = limits.nftScript([25575, 25576]);
  assert.match(script, /^delete table inet rconsole$/m);
  assert.match(script, /tcp dport \{ 25575, 25576 \} drop/);
  assert.match(script, /iif "lo" accept/);
  assert.doesNotMatch(limits.nftScript([]), /chain/);
  // Syntax check where nft can parse rulesets (root in CI containers).
  const check = (s) => {
    const file = path.join(root, 'check.nft');
    fs.writeFileSync(file, s);
    return spawnSync('nft', ['-c', '-f', file], { encoding: 'utf8' });
  };
  const r = check(script);
  if (r.error || /Operation not permitted|permission/i.test(r.stderr)) return;
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(check(limits.nftScript([])).status, 0);
});

'use strict';
// The instance model: what instance.json may hold, and the java command line
// built from it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const instances = require('../lib/instances');

const base = {
  id: 'survival', name: 'Survival', distribution: 'paper', version: '26.3', build: 178, java: 25,
  memoryMb: 4096, port: 25565, flags: 'aikar', launch: { type: 'jar', path: 'paper-26.3-178.jar' },
};

test('a valid instance is kept as is, with defaults filled in', () => {
  const i = instances.validate(base);
  assert.strictEqual(i.id, 'survival');
  assert.strictEqual(i.autostart, false);
  assert.strictEqual(i.kind, 'server');
});

test('unsafe or out-of-range fields are refused', () => {
  const bad = [
    [{ id: '../etc' }, /id/],
    [{ id: 'Survival' }, /id/],
    [{ distribution: 'bedrock' }, /distribution/],
    [{ version: '26.3; rm' }, /version/],
    [{ build: '1 -x' }, /build/],
    [{ java: 7 }, /Java/],
    [{ memoryMb: 100 }, /memory/i],
    [{ port: 80 }, /port/],
    [{ flags: '-XX:+Evil' }, /flags/],
    [{ launch: { type: 'jar', path: '../../bin/sh' } }, /launch/],
    [{ launch: { type: 'jar', path: '/usr/bin/x.jar' } }, /launch/],
    [{ launch: { type: 'argsfile', path: 'libraries/x/unix_args.txt -Dx' } }, /launch/],
    [{ launch: { type: 'shell', path: 'run.sh' } }, /launch/],
  ];
  for (const [patch, re] of bad) assert.throws(() => instances.validate({ ...base, ...patch }), re, JSON.stringify(patch));
});

test('command: aikar flags, equal heap bounds, the jar and nogui', () => {
  const argv = instances.command(instances.validate(base), '/srv/minecraft/.java/25');
  assert.strictEqual(argv[0], '/srv/minecraft/.java/25/bin/java');
  assert.ok(argv.includes('-Xms4096M') && argv.includes('-Xmx4096M'));
  assert.ok(argv.includes('-XX:+UseG1GC'));
  assert.deepStrictEqual(argv.slice(-3), ['-jar', 'paper-26.3-178.jar', 'nogui']);
});

test('command: Forge and NeoForge start from their args file', () => {
  const i = instances.validate({ ...base, distribution: 'neoforge', build: '26.3.0.86', flags: 'default', launch: { type: 'argsfile', path: 'libraries/net/neoforged/neoforge/26.3.0.86/unix_args.txt' } });
  const argv = instances.command(i, '/j');
  assert.deepStrictEqual(argv, ['/j/bin/java', '-Xms1024M', '-Xmx4096M', '-XX:+UseG1GC', '-Xlog:gc:file=logs/gc.log:time:filecount=2,filesize=4M', '@libraries/net/neoforged/neoforge/26.3.0.86/unix_args.txt', 'nogui']);
});

test('command: ZGC on Java 21+ (generational flag only before 23), Aikar on older Java', () => {
  const zgc = (java) => instances.command(instances.validate({ ...base, java, memoryMb: 16384, flags: 'zgc' }), '/j');
  assert.ok(zgc(25).includes('-XX:+UseZGC') && !zgc(25).includes('-XX:+ZGenerational'));
  assert.ok(zgc(21).includes('-XX:+ZGenerational'));
  assert.ok(zgc(25).includes('-Xms16384M'));
  assert.ok(zgc(17).includes('-XX:+UseG1GC') && !zgc(17).includes('-XX:+UseZGC'));
});

test('ports, proxy and memory ceiling', () => {
  const i = instances.validate({ ...base, rconPort: 25576, proxy: 'lobby', portLock: true, extraPorts: [8100, 8100, 24454] });
  assert.deepStrictEqual([i.rconPort, i.proxy, i.portLock, i.extraPorts], [25576, 'lobby', true, [8100, 24454]]);
  assert.deepStrictEqual([instances.validate(base).rconPort, instances.validate(base).extraPorts], [null, []]);
  for (const bad of [{ extraPorts: [80] }, { extraPorts: Array.from({ length: 9 }, (_, n) => 9000 + n) }, { extraPorts: '8100' }, { rconPort: 22 }, { proxy: '../x' }, { flags: ['aikar'] }]) {
    assert.throws(() => instances.validate({ ...base, ...bad }), undefined, JSON.stringify(bad));
  }
  assert.strictEqual(instances.memoryMaxMb({ memoryMb: 4096 }), 6144);
  assert.strictEqual(instances.memoryMaxMb({ memoryMb: 1024 }), 2560);
});

test('command: a proxy gets no nogui', () => {
  const i = instances.validate({ ...base, distribution: 'velocity', version: '3.4.0', java: 21, memoryMb: 512, flags: 'default', launch: { type: 'jar', path: 'velocity.jar' } });
  assert.deepStrictEqual(instances.command(i, '/j').slice(-2), ['-jar', 'velocity.jar']);
});

test('read and list instances from a servers folder, skipping broken ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-instances-'));
  fs.mkdirSync(path.join(dir, 'survival'));
  fs.writeFileSync(path.join(dir, 'survival', 'instance.json'), JSON.stringify(base));
  fs.mkdirSync(path.join(dir, 'broken'));
  fs.writeFileSync(path.join(dir, 'broken', 'instance.json'), '{');
  fs.mkdirSync(path.join(dir, '.java'));
  fs.mkdirSync(path.join(dir, 'other'));
  fs.writeFileSync(path.join(dir, 'other', 'instance.json'), JSON.stringify({ ...base, id: 'creative' }));
  assert.strictEqual(instances.read(dir, 'survival').memoryMb, 4096);
  assert.deepStrictEqual(instances.list(dir).map((i) => i.id), ['survival']);
  assert.throws(() => instances.read(dir, 'other'), /folder/);
});

test('read refuses an instance.json that is a link', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-instances-'));
  fs.mkdirSync(path.join(dir, 'survival'));
  fs.writeFileSync(path.join(dir, 'elsewhere.json'), JSON.stringify(base));
  fs.symlinkSync(path.join(dir, 'elsewhere.json'), path.join(dir, 'survival', 'instance.json'));
  assert.throws(() => instances.read(dir, 'survival'));
});

test('non-string ids, versions and launch paths are refused', () => {
  assert.throws(() => instances.validate({ ...base, version: 1.20 }), /version/);
  assert.throws(() => instances.validate({ ...base, launch: { type: 'jar', path: ['server.jar'] } }), /launch/);
  assert.throws(() => instances.validate({ ...base, id: ['survival'] }), /id/);
});

test('read refuses an instance folder that is a link; list reports what it skips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-instances-'));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-elsewhere-'));
  fs.writeFileSync(path.join(elsewhere, 'instance.json'), JSON.stringify(base));
  fs.symlinkSync(elsewhere, path.join(dir, 'survival'));
  assert.throws(() => instances.read(dir, 'survival'), /folder/);
  const skipped = [];
  assert.deepStrictEqual(instances.list(dir, (name) => skipped.push(name)), []);
  assert.deepStrictEqual(skipped, ['survival']);
});

test('command: Java 8 servers start without the GC log flag (-Xlog needs Java 9)', () => {
  const argv = instances.command(instances.validate({ ...base, version: '1.16.5', java: 8 }), '/j');
  assert.ok(!argv.some((a) => a.startsWith('-Xlog')));
  assert.ok(instances.command(instances.validate(base), '/j').some((a) => a.startsWith('-Xlog:gc:')));
});

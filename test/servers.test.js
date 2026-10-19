'use strict';
// Helper tasks that create and delete servers in SERVERS_DIR.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rconsole-servers-'));
const SV = path.join(root, 'servers');
const BK = path.join(root, 'backups');
process.env.SERVERS_DIR = SV;
process.env.BACKUP_DIR = BK;
// .tar.gz names below; zstd has its own test.
process.env.BACKUP_COMPRESSION = 'gzip';
process.env.MC_DIR = path.join(root, 'mc');
process.env.STATE_DIR = path.join(root, 'state');
fs.mkdirSync(SV);
fs.mkdirSync(BK);
fs.mkdirSync(path.join(SV, '.java', '25', 'bin'), { recursive: true });
fs.writeFileSync(path.join(SV, '.java', '25', 'bin', 'java'), '');

const servers = require('../bin/mc-servers');
const { TASKS } = servers;
const instances = require('../lib/instances');

const JAR = Buffer.from('fake paper jar');
const JAR2 = Buffer.from('newer paper jar');
const JAR2_SHA = crypto.createHash('sha256').update(JAR2).digest('hex');
const JAR_SHA = crypto.createHash('sha256').update(JAR).digest('hex'); // what the API publishes
const sha = (algo, b) => crypto.createHash(algo).update(b).digest('hex');
const FILL = 'https://fill.papermc.io/v3/projects/paper/versions/26.3/builds';
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const VJSON = JSON.stringify({ downloads: { server: { sha1: 'b'.repeat(40), url: 'https://piston-data.mojang.com/s.jar' } }, javaVersion: { majorVersion: 25 } });

const VFILL = 'https://fill.papermc.io/v3/projects/velocity/versions/3.4.0/builds';
// A Velocity jar is a zip with its default config inside.
const VJAR = require('./zip.test').zip({ 'default-velocity.toml': fs.readFileSync(path.join(__dirname, 'fixtures', 'default-velocity.toml')) });
fs.mkdirSync(path.join(SV, '.java', '21', 'bin'), { recursive: true });
fs.writeFileSync(path.join(SV, '.java', '21', 'bin', 'java'), '');

global.fetch = async (url) => {
  const routes = {
    [FILL]: [{ id: 178, channel: 'STABLE' }],
    [`${FILL}/178`]: { downloads: { 'server:default': { name: 'paper-26.3-178.jar', checksums: { sha256: JAR_SHA }, url: 'https://fill-data.papermc.io/paper.jar' } } },
    [MANIFEST]: { versions: [{ id: '26.3', type: 'release', url: 'https://piston-meta.mojang.com/26.3.json', sha1: sha('sha1', VJSON) }] },
    'https://piston-meta.mojang.com/26.3.json': VJSON,
    'https://fill-data.papermc.io/paper.jar': JAR,
    [`${FILL}/180`]: { downloads: { 'server:default': { name: 'paper-26.3-180.jar', checksums: { sha256: JAR2_SHA }, url: 'https://fill-data.papermc.io/paper-180.jar' } } },
    'https://fill-data.papermc.io/paper-180.jar': JAR2,
    'https://meta.fabricmc.net/v2/versions/installer': [{ version: '1.1.2', stable: true, url: 'https://maven.fabricmc.net/fabric-installer-1.1.2.jar' }],
    'https://maven.fabricmc.net/fabric-installer-1.1.2.jar': JAR,
    'https://maven.fabricmc.net/fabric-installer-1.1.2.jar.sha256': JAR_SHA,
    'https://api.mojang.com/users/profiles/minecraft/masseo': { id: '0123456789abcdef0123456789abcdef', name: 'Masseo' },
    [VFILL]: [{ id: 50, channel: 'STABLE' }],
    [`${VFILL}/50`]: { downloads: { 'server:default': { name: 'velocity-3.4.0-50.jar', checksums: { sha256: sha('sha256', VJAR) }, url: 'https://fill-data.papermc.io/velocity.jar' } } },
    'https://fill-data.papermc.io/velocity.jar': VJAR,
  };
  const body = routes[String(url)];
  if (body === undefined) return { ok: false, status: 404 };
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return { ok: true, status: 200, json: async () => JSON.parse(buf), text: async () => buf.toString(), arrayBuffer: async () => buf };
};

const wish = { id: 'survival', name: 'Survival', distribution: 'paper', version: '26.3', memoryMb: 2048, port: 25565, flags: 'aikar', eula: { by: 'masseo', at: '2026-10-16T20:00:00Z' } };

test('create: refuses without the EULA', async () => {
  await assert.rejects(TASKS['server-create']({ ...wish, eula: null }), /EULA/);
  assert.ok(!fs.existsSync(path.join(SV, 'survival')));
});

test('create: installs the verified jar, RCON, EULA and instance.json', async () => {
  const r = await TASKS['server-create'](wish);
  assert.deepStrictEqual([r.id, r.build, r.java, r.verified], ['survival', 178, 25, 'sha256']);
  const dir = path.join(SV, 'survival');
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'paper-26.3-178.jar')), JAR);
  const props = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
  assert.match(props, /^server-port=25565$/m);
  assert.match(props, /^enable-rcon=true$/m);
  assert.match(props, /^rcon\.password=[A-Za-z0-9_-]{32}$/m);
  assert.match(fs.readFileSync(path.join(dir, 'eula.txt'), 'utf8'), /masseo[\s\S]*^eula=true$/m);
  const i = instances.read(SV, 'survival');
  assert.deepStrictEqual(i.launch, { type: 'jar', path: 'paper-26.3-178.jar' });
  assert.strictEqual(i.java, 25);
  assert.ok(!fs.readdirSync(SV).some((f) => f.endsWith('.tmp')));
});

test('create: recommended settings, Paper configs and the owner on the whitelist', async () => {
  const dir = path.join(SV, 'survival');
  const props = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
  for (const line of ['white-list=true', 'enforce-whitelist=true', 'log-ips=false', 'simulation-distance=6', 'sync-chunk-writes=false']) assert.match(props, new RegExp(`^${line}$`, 'm'));
  assert.doesNotMatch(props, /^server-ip=/m);
  assert.match(fs.readFileSync(path.join(dir, 'config', 'paper-world-defaults.yml'), 'utf8'), /anti-xray:\n {4}enabled: true/);
  assert.strictEqual(instances.read(SV, 'survival').rconPort, Number(props.match(/^rcon\.port=(\d+)$/m)[1]));
  const r = await TASKS['server-create']({ ...wish, id: 'owned', port: 25590, owner: 'masseo' });
  assert.strictEqual(r.whitelisted, 'Masseo');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(SV, 'owned', 'whitelist.json'), 'utf8')), [{ uuid: '01234567-89ab-cdef-0123-456789abcdef', name: 'Masseo' }]);
  // Without the recommended settings: vanilla's defaults, no whitelist.
  await TASKS['server-create']({ ...wish, id: 'plain', port: 25591, owner: 'masseo', recommended: false });
  assert.doesNotMatch(fs.readFileSync(path.join(SV, 'plain', 'server.properties'), 'utf8'), /white-list/);
  assert.ok(!fs.existsSync(path.join(SV, 'plain', 'whitelist.json')));
  assert.ok(!fs.existsSync(path.join(SV, 'plain', 'config')));
  for (const id of ['owned', 'plain']) await TASKS['server-delete']({ id, archive: false });
});

test('create: a game port may not be another server\'s RCON port, and RCON skips game ports', async () => {
  const rcon = instances.read(SV, 'survival').rconPort;
  await assert.rejects(TASKS['server-create']({ ...wish, id: 'clash', port: rcon }), /RCON port/);
  // The next free RCON port is taken as a game port first.
  const next = rcon + 1;
  await TASKS['server-create']({ ...wish, id: 'onrcon', port: next });
  assert.notStrictEqual(instances.read(SV, 'onrcon').rconPort, next);
  await TASKS['server-delete']({ id: 'onrcon', archive: false });
});

test('proxy: Velocity with modern forwarding; a server behind it is local only and registered', async () => {
  await TASKS['server-create']({ id: 'proxy', name: 'proxy', distribution: 'velocity', version: '3.4.0', memoryMb: 512, port: 25577 });
  const pdir = path.join(SV, 'proxy');
  const secret = fs.readFileSync(path.join(pdir, 'forwarding.secret'), 'utf8');
  assert.match(secret, /^[A-Za-z0-9_-]{32}$/);
  assert.match(fs.readFileSync(path.join(pdir, 'velocity.toml'), 'utf8'), /^player-info-forwarding-mode = "MODERN"$/m);
  await assert.rejects(TASKS['server-create']({ ...wish, id: 'modded', distribution: 'fabric', port: 25580, proxy: 'proxy' }), /Paper, Folia and Purpur/);
  await assert.rejects(TASKS['server-create']({ ...wish, id: 'lobby', port: 25580, proxy: 'survival' }), /not a proxy/);
  await TASKS['server-create']({ ...wish, id: 'lobby', port: 25580, proxy: 'proxy' });
  const dir = path.join(SV, 'lobby');
  const props = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
  assert.match(props, /^server-ip=127\.0\.0\.1$/m);
  assert.match(props, /^online-mode=false$/m);
  assert.ok(fs.readFileSync(path.join(dir, 'config', 'paper-global.yml'), 'utf8').includes(`secret: '${secret}'`));
  assert.strictEqual(instances.read(SV, 'lobby').proxy, 'proxy');
  let toml = fs.readFileSync(path.join(pdir, 'velocity.toml'), 'utf8');
  assert.match(toml, /^lobby = "127\.0\.0\.1:25580"$/m);
  assert.match(toml, /^try = \["lobby"\]$/m);
  await TASKS['server-delete']({ id: 'lobby', archive: false });
  toml = fs.readFileSync(path.join(pdir, 'velocity.toml'), 'utf8');
  assert.doesNotMatch(toml, /lobby/);
  await TASKS['server-delete']({ id: 'proxy', archive: false });
});

test('configure: memory, flags and port lock; the RCON port is recorded', async () => {
  const dir = path.join(SV, 'survival');
  const i = JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8'));
  delete i.rconPort; // as written before 4.3
  fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify(i));
  const r = await TASKS['server-configure']({ id: 'survival', memoryMb: 3072, flags: 'zgc', portLock: true, extraPorts: [8100], port: 1, launch: { type: 'jar', path: 'evil.jar' } });
  assert.deepStrictEqual([r.memoryMb, r.flags, r.portLock, r.extraPorts], [3072, 'zgc', true, [8100]]);
  const after = instances.read(SV, 'survival');
  assert.deepStrictEqual([after.port, after.launch.path], [25565, 'paper-26.3-178.jar'], 'only the settings change');
  assert.match(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8'), new RegExp(`^rcon\\.port=${after.rconPort}$`, 'm'));
  await assert.rejects(TASKS['server-configure']({ id: 'survival', extraPorts: [22] }), /Extra ports/);
  await TASKS['server-configure']({ id: 'survival', memoryMb: 2048, flags: 'aikar', portLock: false, extraPorts: [] });
});

test('create: a second server gets its own RCON port and may not reuse the game port', async () => {
  await assert.rejects(TASKS['server-create']({ ...wish, id: 'creative' }), /Port 25565/);
  await TASKS['server-create']({ ...wish, id: 'creative', port: 25566 });
  const rcon = (id) => fs.readFileSync(path.join(SV, id, 'server.properties'), 'utf8').match(/^rcon\.port=(\d+)$/m)[1];
  assert.notStrictEqual(rcon('creative'), rcon('survival'));
  await assert.rejects(TASKS['server-create'](wish), /already exists/);
});

test('create: the port of a server rconsole attaches to is taken too', async () => {
  fs.mkdirSync(process.env.MC_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.MC_DIR, 'server.properties'), 'server-port=25599\n');
  await assert.rejects(TASKS['server-create']({ ...wish, id: 'clash', port: 25599 }), /Port 25599/);
  fs.rmSync(path.join(process.env.MC_DIR, 'server.properties'));
});

test('create: a checksum mismatch leaves nothing behind', async () => {
  const real = JAR.toString();
  JAR.write('tampered!!!!!!');
  await assert.rejects(TASKS['server-create']({ ...wish, id: 'broken', port: 25567 }), /Checksum/);
  JAR.write(real);
  assert.ok(!fs.existsSync(path.join(SV, 'broken')));
  assert.ok(!fs.readdirSync(SV).some((f) => f.includes('broken')));
});

test('update: a newer build is installed next to the old one, rollback swaps back', async () => {
  const r = await TASKS['server-update']({ id: 'survival', version: '26.3', build: 180 });
  assert.deepStrictEqual([r.build, r.verified], [180, 'sha256']);
  let i = instances.read(SV, 'survival');
  assert.deepStrictEqual([i.build, i.launch.path, i.previous.build, i.previous.launch.path], [180, 'paper-26.3-180.jar', 178, 'paper-26.3-178.jar']);
  assert.ok(fs.existsSync(path.join(SV, 'survival', 'paper-26.3-178.jar')));
  await assert.rejects(TASKS['server-update']({ id: 'survival', version: '26.3', build: 180 }), /already runs/);
  await TASKS['server-update']({ id: 'survival', rollback: true });
  i = instances.read(SV, 'survival');
  assert.deepStrictEqual([i.build, i.launch.path, i.previous.build], [178, 'paper-26.3-178.jar', 180]);
});

test('update: a failed mod loader install puts the old files back', async () => {
  const dir = path.join(SV, 'modded');
  fs.mkdirSync(path.join(dir, 'libraries', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fabric-server-launch.jar'), 'old launcher');
  fs.writeFileSync(path.join(dir, 'server.jar'), 'old vanilla');
  fs.writeFileSync(path.join(dir, 'libraries', 'x', 'lib.jar'), 'old lib');
  const before = { id: 'modded', distribution: 'fabric', version: '26.3', build: '0.19.4', java: 25, memoryMb: 2048, port: 25570, launch: { type: 'jar', path: 'fabric-server-launch.jar' } };
  fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify(before));
  // The test "java" is an empty file, so the installer fails to run.
  await assert.rejects(TASKS['server-update']({ id: 'modded', version: '26.3', build: '0.19.5' }));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'libraries', 'x', 'lib.jar'), 'utf8'), 'old lib');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'server.jar'), 'utf8'), 'old vanilla');
  assert.ok(!fs.existsSync(path.join(dir, '.rconsole-previous')));
  assert.strictEqual(instances.read(SV, 'modded').build, '0.19.4');
  await assert.rejects(TASKS['server-update']({ id: 'modded', rollback: true }), /Nothing to roll back/);
});

test('delete: archives the server into the backup folder, then removes it', async () => {
  const r = await TASKS['server-delete']({ id: 'creative' });
  assert.match(r.archived, /^deleted-servers\/creative-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.gz$/);
  assert.ok(!require('../lib/names').parseBackupName(require('path').basename(r.archived)) || !fs.existsSync(path.join(BK, require('path').basename(r.archived))), 'not listed as a world backup');
  assert.ok(!fs.existsSync(path.join(SV, 'creative')));
  const listing = execFileSync('tar', ['-tzf', path.join(BK, r.archived)], { encoding: 'utf8' });
  assert.match(listing, /^creative\/instance\.json$/m);
});

test('delete: unknown or invalid ids are refused', async () => {
  await assert.rejects(TASKS['server-delete']({ id: 'nope' }));
  await assert.rejects(TASKS['server-delete']({ id: '../mc' }), /Invalid/);
});

test('findLaunch: Forge and NeoForge args files, Fabric launcher', () => {
  const dir = fs.mkdtempSync(path.join(root, 'launch-'));
  fs.mkdirSync(path.join(dir, 'libraries/net/neoforged/neoforge/26.3.0.86'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'libraries/net/neoforged/neoforge/26.3.0.86/unix_args.txt'), '');
  assert.deepStrictEqual(servers.findLaunch(dir, { distribution: 'neoforge', version: '26.3', build: '26.3.0.86' }), { type: 'argsfile', path: 'libraries/net/neoforged/neoforge/26.3.0.86/unix_args.txt' });
  assert.strictEqual(servers.findLaunch(dir, { distribution: 'forge', version: '26.3', build: '66.0.12' }), null);
  fs.writeFileSync(path.join(dir, 'fabric-server-launch.jar'), '');
  assert.deepStrictEqual(servers.findLaunch(dir, { distribution: 'fabric' }), { type: 'jar', path: 'fabric-server-launch.jar' });
});

test('inspectJre and checkTree: one top folder; links only where they are left out', async () => {
  const src = fs.mkdtempSync(path.join(root, 'jre-'));
  fs.mkdirSync(path.join(src, 'jdk-25-jre', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(src, 'jdk-25-jre', 'legal', 'x'), { recursive: true });
  fs.writeFileSync(path.join(src, 'jdk-25-jre', 'bin', 'java'), '');
  fs.symlinkSync('../java.base/LICENSE', path.join(src, 'jdk-25-jre', 'legal', 'x', 'LICENSE'));
  execFileSync('tar', ['-czf', path.join(root, 'ok.tgz'), '-C', src, 'jdk-25-jre']);
  assert.strictEqual(await servers.inspectJre(path.join(root, 'ok.tgz')), 'jdk-25-jre');
  fs.mkdirSync(path.join(src, 'other'));
  execFileSync('tar', ['-czf', path.join(root, 'two.tgz'), '-C', src, 'jdk-25-jre', 'other']);
  await assert.rejects(servers.inspectJre(path.join(root, 'two.tgz')), /one top folder/);
  assert.throws(() => servers.checkTree(path.join(src, 'jdk-25-jre')), /link/);
  fs.rmSync(path.join(src, 'jdk-25-jre', 'legal'), { recursive: true });
  servers.checkTree(path.join(src, 'jdk-25-jre'));
});

test('helper jobs naming a server work in its folder; unknown servers are refused', () => {
  fs.mkdirSync(path.join(SV, 'survival', 'world', 'region'), { recursive: true });
  fs.writeFileSync(path.join(SV, 'survival', 'world', 'level.dat'), 'S');
  const job = (id, request) => {
    fs.mkdirSync(path.join(BK, '.requests'), { recursive: true });
    fs.writeFileSync(path.join(BK, '.requests', `${id}.json`), JSON.stringify(request));
    try {
      execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'mc-helper.js'), 'job', id], { env: process.env, stdio: 'pipe' });
    } catch {}
    return JSON.parse(fs.readFileSync(path.join(BK, '.jobs', `${id}.json`), 'utf8'));
  };
  const ok = job('a'.repeat(32), { kind: 'backup', args: { stamp: '2026-10-16_20-00-00' }, instance: 'survival' });
  assert.strictEqual(ok.ok, true, ok.error);
  assert.match(execFileSync('tar', ['-tzf', path.join(BK, ok.file)], { encoding: 'utf8' }), /^world\/level\.dat$/m);
  const bad = job('b'.repeat(32), { kind: 'backup', args: { stamp: '2026-10-16_20-00-01' }, instance: '../mc' });
  assert.strictEqual(bad.ok, false);
});

test('rollback refuses a snapshot that is a link (a plugin pointing it at another server)', async () => {
  const dir = path.join(SV, 'modded');
  const other = path.join(SV, 'victim');
  fs.mkdirSync(path.join(other, 'world'), { recursive: true });
  fs.writeFileSync(path.join(other, 'secret.txt'), 'B');
  const i = JSON.parse(fs.readFileSync(path.join(dir, 'instance.json'), 'utf8'));
  i.previous = { version: '26.3', build: '0.19.3', java: 25, launch: { type: 'jar', path: 'fabric-server-launch.jar' }, snapshot: true };
  fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify(i));
  fs.symlinkSync('../victim', path.join(dir, '.rconsole-previous'));
  await assert.rejects(TASKS['server-update']({ id: 'modded', rollback: true }), /link/);
  assert.ok(fs.existsSync(path.join(other, 'secret.txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'secret.txt')));
  fs.rmSync(path.join(dir, '.rconsole-previous'));
});

test('in-place update: the installer runs in a clean folder; planted links lead nowhere', async () => {
  const dir = path.join(SV, 'modded');
  const victim = path.join(SV, 'victim', 'level.dat');
  fs.writeFileSync(victim, 'VICTIM');
  // A plugin plants links where an installer writes its log and jars.
  fs.symlinkSync(victim, path.join(dir, 'fabric-installer-1.1.2.jar.log'));
  fs.writeFileSync(path.join(dir, 'user_jvm_args.txt'), '# mine\n');
  // A "java" that does what the Fabric installer does in its folder.
  const java = path.join(SV, '.java', '25', 'bin', 'java');
  fs.writeFileSync(java, '#!/bin/sh\nmkdir -p libraries/y && echo new > libraries/y/lib.jar && echo launcher > fabric-server-launch.jar && echo vanilla > server.jar && echo log > fabric-installer-1.1.2.jar.log && echo args > user_jvm_args.txt\n');
  fs.chmodSync(java, 0o755);
  try {
    const r = await TASKS['server-update']({ id: 'modded', version: '26.3', build: '0.19.5' });
    assert.strictEqual(r.build, '0.19.5');
  } finally {
    fs.writeFileSync(java, '');
    fs.chmodSync(java, 0o644);
  }
  assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'VICTIM');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'fabric-server-launch.jar'), 'utf8'), 'launcher\n');
  assert.ok(fs.existsSync(path.join(dir, 'libraries', 'y', 'lib.jar')));
  assert.ok(!fs.existsSync(path.join(dir, 'libraries', 'x')), 'old libraries are replaced (kept in the snapshot)');
  assert.ok(fs.existsSync(path.join(dir, '.rconsole-previous', 'libraries', 'x', 'lib.jar')));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'user_jvm_args.txt'), 'utf8'), '# mine\n');
  assert.ok(!fs.readdirSync(SV).some((f) => f.includes('-install')));
});

test('in-place update refuses planted links in libraries/', async () => {
  const dir = path.join(SV, 'modded');
  fs.symlinkSync('../../victim', path.join(dir, 'libraries', 'evil'));
  await assert.rejects(TASKS['server-update']({ id: 'modded', version: '26.3', build: '0.19.6' }), /link/);
  fs.rmSync(path.join(dir, 'libraries', 'evil'));
});

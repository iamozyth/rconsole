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
const JAR_SHA = crypto.createHash('sha256').update(JAR).digest('hex'); // what the API publishes
const sha = (algo, b) => crypto.createHash(algo).update(b).digest('hex');
const FILL = 'https://fill.papermc.io/v3/projects/paper/versions/26.3/builds';
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const VJSON = JSON.stringify({ downloads: { server: { sha1: 'b'.repeat(40), url: 'https://piston-data.mojang.com/s.jar' } }, javaVersion: { majorVersion: 25 } });

global.fetch = async (url) => {
  const routes = {
    [FILL]: [{ id: 178, channel: 'STABLE' }],
    [`${FILL}/178`]: { downloads: { 'server:default': { name: 'paper-26.3-178.jar', checksums: { sha256: JAR_SHA }, url: 'https://fill-data.papermc.io/paper.jar' } } },
    [MANIFEST]: { versions: [{ id: '26.3', type: 'release', url: 'https://piston-meta.mojang.com/26.3.json', sha1: sha('sha1', VJSON) }] },
    'https://piston-meta.mojang.com/26.3.json': VJSON,
    'https://fill-data.papermc.io/paper.jar': JAR,
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

test('create: a second server gets its own RCON port and may not reuse the game port', async () => {
  await assert.rejects(TASKS['server-create']({ ...wish, id: 'creative' }), /Port 25565/);
  await TASKS['server-create']({ ...wish, id: 'creative', port: 25566 });
  const rcon = (id) => fs.readFileSync(path.join(SV, id, 'server.properties'), 'utf8').match(/^rcon\.port=(\d+)$/m)[1];
  assert.notStrictEqual(rcon('creative'), rcon('survival'));
  await assert.rejects(TASKS['server-create'](wish), /already exists/);
});

test('create: a checksum mismatch leaves nothing behind', async () => {
  const real = JAR.toString();
  JAR.write('tampered!!!!!!');
  await assert.rejects(TASKS['server-create']({ ...wish, id: 'broken', port: 25567 }), /Checksum/);
  JAR.write(real);
  assert.ok(!fs.existsSync(path.join(SV, 'broken')));
  assert.ok(!fs.readdirSync(SV).some((f) => f.includes('broken')));
});

test('delete: archives the server into the backup folder, then removes it', async () => {
  const r = await TASKS['server-delete']({ id: 'creative' });
  assert.match(r.archived, /^server-creative-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.tar\.gz$/);
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

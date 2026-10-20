'use strict';
// Modrinth modpacks: reading modrinth.index.json, and the helper installing
// a pack into a new server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rconsole-modpack-'));
const SV = path.join(root, 'servers');
process.env.SERVERS_DIR = SV;
process.env.BACKUP_DIR = path.join(root, 'backups');
process.env.MC_DIR = path.join(root, 'mc');
process.env.STATE_DIR = path.join(root, 'state');
fs.mkdirSync(SV);
// A "java" that does what the Fabric installer does in its folder.
fs.mkdirSync(path.join(SV, '.java', '25', 'bin'), { recursive: true });
fs.writeFileSync(path.join(SV, '.java', '25', 'bin', 'java'), '#!/bin/sh\necho launcher > fabric-server-launch.jar && echo vanilla > server.jar\n', { mode: 0o755 });

const modpack = require('../lib/modpack');
const { zip } = require('./archives');
const { TASKS } = require('../bin/mc-servers');
const instances = require('../lib/instances');

const sha = (algo, b) => crypto.createHash(algo).update(b).digest('hex');
const MOD_A = Buffer.from('fake sodium jar');
const MOD_B = Buffer.from('fake lithium jar');
const CLIENT = Buffer.from('client only');

function index(over = {}) {
  return {
    formatVersion: 1, game: 'minecraft', versionId: '6.1.0', name: 'Test Pack',
    dependencies: { minecraft: '26.3', 'fabric-loader': '0.19.5' },
    files: [
      { path: 'mods/a.jar', hashes: { sha1: sha('sha1', MOD_A), sha512: sha('sha512', MOD_A) }, env: { client: 'required', server: 'required' }, downloads: ['https://cdn.modrinth.com/data/a/a.jar'], fileSize: MOD_A.length },
      { path: 'mods/b.jar', hashes: { sha512: sha('sha512', MOD_B) }, env: { client: 'required', server: 'optional' }, downloads: ['https://evil.example/b.jar', 'https://github.com/x/b/releases/download/1/b.jar'], fileSize: MOD_B.length },
      { path: 'mods/menu.jar', hashes: { sha512: sha('sha512', CLIENT) }, env: { client: 'required', server: 'unsupported' }, downloads: ['https://cdn.modrinth.com/data/c/c.jar'] },
    ],
    ...over,
  };
}

test('index: loader, Minecraft version and the files a server needs', () => {
  const p = modpack.parseIndex(JSON.stringify(index()));
  assert.deepStrictEqual([p.name, p.version, p.mc, p.distribution, p.loaderVersion, p.clientOnly], ['Test Pack', '6.1.0', '26.3', 'fabric', '0.19.5', 1]);
  assert.deepStrictEqual(p.files.map((f) => [f.path, f.url]), [['mods/a.jar', 'https://cdn.modrinth.com/data/a/a.jar'], ['mods/b.jar', 'https://github.com/x/b/releases/download/1/b.jar']]);
  assert.strictEqual(modpack.parseIndex(JSON.stringify(index({ dependencies: { minecraft: '1.21.1', neoforge: '21.1.77' } }))).distribution, 'neoforge');
  assert.strictEqual(modpack.parseIndex(JSON.stringify(index({ dependencies: { minecraft: '1.21.1' } }))).distribution, 'vanilla');
});

test('index: refuses unsafe paths, foreign hosts, missing hashes and unknown loaders', () => {
  const file = (f) => JSON.stringify(index({ files: [{ path: 'mods/x.jar', hashes: { sha512: 'a'.repeat(128) }, downloads: ['https://cdn.modrinth.com/x.jar'], ...f }] }));
  assert.throws(() => modpack.parseIndex(file({ path: '../../etc/passwd' })), /unsafe path/);
  assert.throws(() => modpack.parseIndex(file({ path: '/root/x' })), /unsafe path/);
  assert.throws(() => modpack.parseIndex(file({ path: 'instance.json' })), /may not replace instance\.json/);
  assert.throws(() => modpack.parseIndex(file({ path: 'server.properties' })), /may not replace/);
  assert.throws(() => modpack.parseIndex(file({ downloads: ['https://evil.example/x.jar'] })), /isn't hosted/);
  assert.throws(() => modpack.parseIndex(file({ downloads: ['http://cdn.modrinth.com/x.jar'] })), /isn't hosted/);
  assert.throws(() => modpack.parseIndex(file({ hashes: { sha1: 'a'.repeat(40) } })), /no sha512/);
  assert.throws(() => modpack.parseIndex(JSON.stringify(index({ dependencies: { minecraft: '26.3', 'liteloader': '1' } }))), /can't install/);
  assert.throws(() => modpack.parseIndex(JSON.stringify(index({ dependencies: { minecraft: '26.3', forge: '1', 'fabric-loader': '0.1' } }))), /more than one loader/);
  assert.throws(() => modpack.parseIndex(JSON.stringify(index({ dependencies: { minecraft: '1.16.5', forge: '36.2.39' } }))), /before 1\.17/);
  assert.throws(() => modpack.parseIndex(JSON.stringify(index({ dependencies: { minecraft: '26.3', 'fabric-loader': '--evil' } }))), /Invalid fabric-loader version/);
  assert.throws(() => modpack.parseIndex(JSON.stringify(index({ formatVersion: 2 }))), /Unsupported/);
});

test('server.properties from a pack never sets rconsole\'s ports or RCON', () => {
  assert.deepStrictEqual(modpack.mergeProperties({ difficulty: 'hard', 'rcon.password': 'x', 'server-port': '1', 'enable-rcon': 'false', 'online-mode': 'false' }), { difficulty: 'hard' });
});

// --- the helper ---------------------------------------------------------------------

const VERSION_ID = 'AbCd1234';
function mrpack(idx, extra = []) {
  return zip([
    { name: 'modrinth.index.json', data: JSON.stringify(idx) },
    { name: 'overrides/config/sodium.json', data: '{"a":1}' },
    { name: 'overrides/server.properties', data: 'difficulty=hard\nrcon.password=fromthepack\nview-distance=12\n' },
    { name: 'server-overrides/config/sodium.json', data: '{"server":true}' },
    ...extra,
  ]);
}
let PACK = mrpack(index());
const VJSON = JSON.stringify({ downloads: { server: { sha1: 'b'.repeat(40), url: 'https://piston-data.mojang.com/s.jar' } }, javaVersion: { majorVersion: 25 } });
const INSTALLER = Buffer.from('fabric installer');
const fetched = [];

global.fetch = async (url) => {
  fetched.push(String(url));
  const routes = {
    [`https://api.modrinth.com/v2/version/${VERSION_ID}`]: () => ({ id: VERSION_ID, project_id: 'PrOj1234', files: [{ primary: true, filename: 'pack.mrpack', url: 'https://cdn.modrinth.com/data/PrOj1234/pack.mrpack', hashes: { sha512: sha('sha512', PACK) }, size: PACK.length }] }),
    'https://cdn.modrinth.com/data/PrOj1234/pack.mrpack': () => PACK,
    'https://cdn.modrinth.com/data/a/a.jar': () => MOD_A,
    'https://github.com/x/b/releases/download/1/b.jar': () => MOD_B,
    'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json': () => ({ versions: [{ id: '26.3', type: 'release', url: 'https://piston-meta.mojang.com/26.3.json', sha1: sha('sha1', VJSON) }] }),
    'https://piston-meta.mojang.com/26.3.json': () => VJSON,
    'https://meta.fabricmc.net/v2/versions/installer': () => [{ version: '1.1.2', stable: true, url: 'https://maven.fabricmc.net/fabric-installer-1.1.2.jar' }],
    'https://maven.fabricmc.net/fabric-installer-1.1.2.jar': () => INSTALLER,
    'https://maven.fabricmc.net/fabric-installer-1.1.2.jar.sha256': () => sha('sha256', INSTALLER),
  };
  const body = routes[String(url)]?.();
  if (body === undefined) return { ok: false, status: 404 };
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return { ok: true, status: 200, json: async () => JSON.parse(buf), text: async () => buf.toString(), arrayBuffer: async () => buf };
};

const wish = { id: 'pack', name: 'pack', distribution: 'fabric', version: '26.3', memoryMb: 6144, port: 25565, flags: 'aikar', eula: { by: 'masseo', at: '2026-10-20T10:00:00Z' }, modpack: { versionId: VERSION_ID } };

test('create from a modpack: loader from the pack, verified mods, overrides, merged properties', async () => {
  const r = await TASKS['server-create'](wish);
  assert.deepStrictEqual([r.distribution, r.build, r.modpack.files, r.modpack.clientOnly], ['fabric', '0.19.5', 2, 1]);
  const dir = path.join(SV, 'pack');
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'mods', 'a.jar')), MOD_A);
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'mods', 'b.jar')), MOD_B);
  assert.ok(!fs.existsSync(path.join(dir, 'mods', 'menu.jar')));
  assert.ok(!fetched.some((u) => u.includes('evil')));
  // server-overrides win over overrides.
  assert.strictEqual(fs.readFileSync(path.join(dir, 'config', 'sodium.json'), 'utf8'), '{"server":true}');
  const props = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
  assert.match(props, /^difficulty=hard$/m);
  assert.match(props, /^view-distance=12$/m);
  assert.match(props, /^white-list=true$/m);
  assert.match(props, /^rcon\.password=[A-Za-z0-9_-]{32}$/m);
  assert.doesNotMatch(props, /fromthepack/);
  const i = instances.read(SV, 'pack');
  assert.deepStrictEqual(i.modpack, { projectId: 'PrOj1234', versionId: VERSION_ID, name: 'Test Pack', version: '6.1.0', files: 2 });
  assert.deepStrictEqual(i.launch, { type: 'jar', path: 'fabric-server-launch.jar' });
  assert.ok(!fs.readdirSync(SV).some((f) => f.endsWith('.tmp')));
});

test('create from a modpack: a wrong hash or a mismatched wish leaves nothing behind', async () => {
  await assert.rejects(TASKS['server-create']({ ...wish, id: 'other', port: 25570, distribution: 'forge' }), /needs fabric for Minecraft 26\.3, not forge/);
  const bad = index();
  bad.files[0].hashes.sha512 = 'f'.repeat(128);
  PACK = mrpack(bad);
  await assert.rejects(TASKS['server-create']({ ...wish, id: 'other', port: 25570 }), /Checksum mismatch/);
  PACK = mrpack(index(), [{ name: 'overrides/instance.json', data: '{}' }]);
  await assert.rejects(TASKS['server-create']({ ...wish, id: 'other', port: 25570 }), /may not replace instance\.json/);
  PACK = mrpack(index(), [{ name: 'overrides/mods', data: 'a file where the folder goes' }]);
  await assert.rejects(TASKS['server-create']({ ...wish, id: 'other', port: 25570 }), /file and a folder|both/);
  assert.ok(!fs.existsSync(path.join(SV, 'other')));
  assert.ok(!fs.readdirSync(SV).some((f) => f.endsWith('.tmp')));
  await assert.rejects(TASKS['server-create']({ ...wish, id: 'other', port: 25570, modpack: { versionId: '../x' } }), /Invalid modpack/);
});

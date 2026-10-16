'use strict';
// The distribution catalog against canned API replies (fetch is stubbed at the
// network boundary; no real requests).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const dist = require('../lib/distributions');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const HASH = 'a'.repeat(64);

function serve(routes) {
  const seen = [];
  global.fetch = async (url) => {
    seen.push(String(url));
    const body = routes[String(url)];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text };
  };
  return seen;
}

const FILL = 'https://fill.papermc.io/v3/projects';

test('paper: release versions only, newest first', async () => {
  serve({ [`${FILL}/paper`]: { versions: { '1.21': ['1.21.4', '1.21.10', '1.21.4-rc1'], '26.1': ['26.3', '26.1-pre2'] } } });
  assert.deepStrictEqual(await dist.versions('paper'), ['26.3', '1.21.10', '1.21.4']);
});

test('velocity: snapshots are left out', async () => {
  serve({ [`${FILL}/velocity`]: { versions: { '3.0.0': ['3.5.0', '3.6.0-SNAPSHOT', '3.4.0'] } } });
  assert.deepStrictEqual(await dist.versions('velocity'), ['3.5.0', '3.4.0']);
});

test('paper: resolve returns a sha256-verified download from papermc.io', async () => {
  serve({
    [`${FILL}/paper/versions/26.3/builds/178`]: {
      id: 178,
      downloads: { 'server:default': { name: 'paper-26.3-178.jar', size: 5, checksums: { sha256: HASH }, url: `https://fill-data.papermc.io/v1/objects/${HASH}/paper-26.3-178.jar` } },
    },
  });
  const r = await dist.resolve('paper', '26.3', 178);
  assert.deepStrictEqual(r, {
    distribution: 'paper', version: '26.3', build: 178, url: `https://fill-data.papermc.io/v1/objects/${HASH}/paper-26.3-178.jar`,
    algo: 'sha256', hash: HASH, size: 5, file: 'paper-26.3-178.jar', install: 'jar', installArgs: [], javaMajor: null,
  });
});

test('paper: without a build, the newest build is resolved', async () => {
  serve({
    [`${FILL}/paper/versions/26.3/builds`]: [{ id: 170, channel: 'STABLE' }, { id: 178, channel: 'STABLE' }],
    [`${FILL}/paper/versions/26.3/builds/178`]: { id: 178, downloads: { 'server:default': { name: 'p.jar', checksums: { sha256: HASH }, url: 'https://fill-data.papermc.io/p.jar' } } },
  });
  assert.strictEqual((await dist.resolve('paper', '26.3')).build, 178);
});

test('paper: a download from another host is refused', async () => {
  serve({ [`${FILL}/paper/versions/26.3/builds/1`]: { downloads: { 'server:default': { checksums: { sha256: HASH }, url: 'https://evil.example/p.jar' } } } });
  await assert.rejects(dist.resolve('paper', '26.3', 1), /host/);
});

test('paper: a build without a checksum is refused', async () => {
  serve({ [`${FILL}/paper/versions/26.3/builds/1`]: { downloads: { 'server:default': { url: 'https://fill-data.papermc.io/p.jar' } } } });
  await assert.rejects(dist.resolve('paper', '26.3', 1), /verifiable/);
});

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
function mojang({ tamper = false } = {}) {
  const versionJson = JSON.stringify({
    id: '26.3',
    downloads: { server: { sha1: 'b'.repeat(40), size: 9, url: `https://piston-data.mojang.com/v1/objects/${'b'.repeat(40)}/server.jar` } },
    javaVersion: { majorVersion: 25 },
  });
  const url = 'https://piston-meta.mojang.com/v1/packages/x/26.3.json';
  return serve({
    [MANIFEST]: {
      latest: { release: '26.3' },
      versions: [
        { id: '26.4-snapshot-1', type: 'snapshot', url: 'https://piston-meta.mojang.com/s.json', sha1: '0'.repeat(40) },
        { id: '26.3', type: 'release', url, sha1: tamper ? '0'.repeat(40) : sha1(versionJson) },
        { id: '1.21.10', type: 'release', url: 'https://piston-meta.mojang.com/o.json', sha1: '0'.repeat(40) },
      ],
    },
    [url]: versionJson,
  });
}

test('vanilla: releases from the Mojang manifest, newest first', async () => {
  mojang();
  assert.deepStrictEqual(await dist.versions('vanilla'), ['26.3', '1.21.10']);
});

test('vanilla: resolve returns the sha1 of the server jar and the Java version', async () => {
  mojang();
  const r = await dist.resolve('vanilla', '26.3');
  assert.strictEqual(r.algo, 'sha1');
  assert.strictEqual(r.hash, 'b'.repeat(40));
  assert.strictEqual(r.javaMajor, 25);
  assert.strictEqual(r.file, 'server.jar');
  assert.strictEqual(r.build, null);
});

test('vanilla: a version file that does not match the manifest is refused', async () => {
  mojang({ tamper: true });
  await assert.rejects(dist.resolve('vanilla', '26.3'), /checksum/i);
});

test('unknown distributions and bad versions are refused before any request', async () => {
  const seen = serve({});
  await assert.rejects(dist.versions('bedrock'), /Unknown distribution/);
  await assert.rejects(dist.resolve('paper', '../x'), /Invalid version/);
  assert.deepStrictEqual(seen, []);
});

test('catalog lists every distribution with its kind and checksum strength', () => {
  const list = dist.list();
  const byId = Object.fromEntries(list.map((d) => [d.id, d]));
  assert.strictEqual(byId.velocity.kind, 'proxy');
  assert.strictEqual(byId.paper.kind, 'server');
  assert.strictEqual(byId.vanilla.verify, 'sha1');
  assert.strictEqual(byId.folia.verify, 'sha256');
});

// --- Purpur --------------------------------------------------------------------

const PURPUR = 'https://api.purpurmc.org/v2/purpur';
const MD5 = 'c'.repeat(32);

test('purpur: resolve uses the md5 the API publishes and its own download URL', async () => {
  serve({ [`${PURPUR}/26.2/latest`]: { version: '26.2', build: '2501', result: 'SUCCESS', md5: MD5 } });
  const r = await dist.resolve('purpur', '26.2');
  assert.deepStrictEqual([r.build, r.algo, r.hash, r.url, r.file, r.install], [2501, 'md5', MD5, `${PURPUR}/26.2/2501/download`, 'purpur-26.2-2501.jar', 'jar']);
});

test('purpur: failed builds are refused', async () => {
  serve({ [`${PURPUR}/26.2/7`]: { build: '7', result: 'FAILURE', md5: MD5 } });
  await assert.rejects(dist.resolve('purpur', '26.2', 7), /verifiable/);
});

test('purpur: builds newest first', async () => {
  serve({ [`${PURPUR}/26.2`]: { builds: { latest: '12', all: ['10', '12', '11'] } } });
  assert.deepStrictEqual((await dist.builds('purpur', '26.2')).map((b) => b.id), [12, 11, 10]);
});

// --- Fabric and Quilt: installer from Maven ------------------------------------

const FABRIC_META = 'https://meta.fabricmc.net/v2/versions';
const FABRIC_INSTALLER = 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.1.2/fabric-installer-1.1.2.jar';

function fabric() {
  return serve({
    [`${FABRIC_META}/game`]: [{ version: '26.4-snapshot-1', stable: false }, { version: '26.3', stable: true }, { version: '1.21.10', stable: true }],
    [`${FABRIC_META}/loader`]: [{ version: '0.20.0', stable: false }, { version: '0.19.5', stable: true }],
    [`${FABRIC_META}/installer`]: [{ version: '1.1.3', stable: false, url: 'x' }, { version: '1.1.2', stable: true, url: FABRIC_INSTALLER }],
    [`${FABRIC_INSTALLER}.sha256`]: `${HASH}\n`,
  });
}

test('fabric: stable game versions only', async () => {
  fabric();
  assert.deepStrictEqual(await dist.versions('fabric'), ['26.3', '1.21.10']);
});

test('fabric: resolve picks the newest stable loader and the installer with its Maven sha256', async () => {
  fabric();
  const r = await dist.resolve('fabric', '26.3');
  assert.deepStrictEqual(
    [r.build, r.url, r.algo, r.hash, r.install, r.installArgs],
    ['0.19.5', FABRIC_INSTALLER, 'sha256', HASH, 'installer', ['server', '-mcversion', '26.3', '-loader', '0.19.5', '-downloadMinecraft']],
  );
});

test('fabric: a loader version with odd characters is refused', async () => {
  fabric();
  await assert.rejects(dist.resolve('fabric', '26.3', '0.19.5 -evil'), /Invalid build/);
});

const QUILT_MAVEN = 'https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer';
test('quilt: installer from Quilt Maven with the newest stable loader', async () => {
  serve({
    'https://meta.quiltmc.org/v3/versions/loader': [{ version: '0.31.0-beta.4' }, { version: '0.30.2' }],
    [`${QUILT_MAVEN}/maven-metadata.xml`]: '<metadata><versioning><release>0.15.1</release></versioning></metadata>',
    [`${QUILT_MAVEN}/0.15.1/quilt-installer-0.15.1.jar.sha256`]: HASH,
  });
  const r = await dist.resolve('quilt', '26.3');
  assert.deepStrictEqual([r.build, r.url, r.install], ['0.30.2', `${QUILT_MAVEN}/0.15.1/quilt-installer-0.15.1.jar`, 'installer']);
  assert.deepStrictEqual(r.installArgs, ['install', 'server', '26.3', '0.30.2', '--download-server', '--install-dir=.']);
});

// --- NeoForge and Forge ------------------------------------------------------------

const NEO = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
const neoMeta = `<metadata><versioning><versions>
  <version>21.1.262</version><version>21.0.5</version><version>20.4.253</version>
  <version>26.1.2.121</version><version>26.3.0.85</version><version>26.3.0.86</version><version>26.3.0.90-beta</version>
</versions></versioning></metadata>`;

test('neoforge: Minecraft versions are derived from NeoForge versions', async () => {
  serve({ [`${NEO}/maven-metadata.xml`]: neoMeta });
  assert.deepStrictEqual(await dist.versions('neoforge'), ['26.3', '26.1.2', '1.21.1', '1.21', '1.20.4']);
  assert.deepStrictEqual((await dist.builds('neoforge', '26.3')).map((b) => b.id), ['26.3.0.86', '26.3.0.85']);
});

test('neoforge: resolve the newest release installer with --installServer', async () => {
  serve({ [`${NEO}/maven-metadata.xml`]: neoMeta, [`${NEO}/21.1.262/neoforge-21.1.262-installer.jar.sha256`]: HASH });
  const r = await dist.resolve('neoforge', '1.21.1');
  assert.deepStrictEqual([r.build, r.url, r.install, r.installArgs], ['21.1.262', `${NEO}/21.1.262/neoforge-21.1.262-installer.jar`, 'installer', ['--installServer']]);
});

const FORGE = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';

test('forge: the recommended build wins over the latest', async () => {
  serve({
    [PROMOS]: { promos: { '26.2-latest': '65.1.5', '26.2-recommended': '65.1.0', '26.3-latest': '66.0.12' } },
    [`${FORGE}/26.2-65.1.0/forge-26.2-65.1.0-installer.jar.sha256`]: HASH,
  });
  assert.deepStrictEqual(await dist.versions('forge'), ['26.3', '26.2']);
  const r = await dist.resolve('forge', '26.2');
  assert.deepStrictEqual([r.build, r.url, r.algo, r.installArgs], ['65.1.0', `${FORGE}/26.2-65.1.0/forge-26.2-65.1.0-installer.jar`, 'sha256', ['--installServer']]);
});

test('maven: a checksum file that is not a hash is refused', async () => {
  serve({ [PROMOS]: { promos: { '26.3-latest': '66.0.12' } }, [`${FORGE}/26.3-66.0.12/forge-26.3-66.0.12-installer.jar.sha256`]: '<html>' });
  await assert.rejects(dist.resolve('forge', '26.3'), /verifiable/);
});

test('paper: without a build, the newest STABLE build wins over a newer experimental one', async () => {
  serve({
    [`${FILL}/paper/versions/26.3/builds`]: [{ id: 180, channel: 'ALPHA' }, { id: 178, channel: 'STABLE' }],
    [`${FILL}/paper/versions/26.3/builds/178`]: { downloads: { 'server:default': { name: 'p.jar', checksums: { sha256: HASH }, url: 'https://fill-data.papermc.io/p.jar' } } },
  });
  assert.strictEqual((await dist.resolve('paper', '26.3')).build, 178);
});

test('builds must have the type their distribution uses', async () => {
  const seen = serve({});
  await assert.rejects(dist.resolve('neoforge', '1.21.1', 262), /Invalid build/);
  await assert.rejects(dist.resolve('paper', '26.3', '178'), /Invalid build/);
  await assert.rejects(dist.resolve('vanilla', '26.3', 1), /Invalid build/);
  assert.deepStrictEqual(seen, []);
});

test('a file name with path parts from an API is replaced', async () => {
  serve({ [`${FILL}/paper/versions/26.3/builds/1`]: { downloads: { 'server:default': { name: '../../.ssh/authorized_keys', checksums: { sha256: HASH }, url: 'https://fill-data.papermc.io/p.jar' } } } });
  assert.strictEqual((await dist.resolve('paper', '26.3', 1)).file, 'paper-26.3.jar');
});

test('forge: only versions with the args-file launch (1.17 and later) are offered', async () => {
  serve({ [PROMOS]: { promos: { '1.7.10-latest': '10.13.4.1614', '1.16.5-recommended': '36.2.34', '1.17.1-latest': '37.1.1', '26.3-latest': '66.0.12' } } });
  assert.deepStrictEqual(await dist.versions('forge'), ['26.3', '1.17.1']);
});

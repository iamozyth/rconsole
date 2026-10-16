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
    algo: 'sha256', hash: HASH, size: 5, file: 'paper-26.3-178.jar', install: 'jar', javaMajor: null,
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

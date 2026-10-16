'use strict';
// Which Java a server needs, and the Temurin runtime that provides it.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const java = require('../lib/java');

const HASH = 'd'.repeat(64);
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

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
function mojang(id, javaVersion) {
  const body = JSON.stringify({ downloads: { server: { sha1: 'b'.repeat(40), url: 'https://piston-data.mojang.com/s.jar' } }, ...(javaVersion ? { javaVersion: { majorVersion: javaVersion } } : {}) });
  const url = `https://piston-meta.mojang.com/v1/packages/x/${id}.json`;
  return { [MANIFEST]: { versions: [{ id, type: 'release', url, sha1: crypto.createHash('sha1').update(body).digest('hex') }] }, [url]: body };
}

test('a server needs the Java version Mojang names for its Minecraft version', async () => {
  serve(mojang('26.3', 25));
  assert.strictEqual(await java.majorFor('paper', '26.3'), 25);
  assert.strictEqual(await java.majorFor('neoforge', '26.3'), 25);
});

test('Minecraft versions without a Java entry need Java 8', async () => {
  serve(mojang('1.12.2', null));
  assert.strictEqual(await java.majorFor('forge', '1.12.2'), 8);
});

test('Velocity needs Java 21 and asks Mojang nothing', async () => {
  const seen = serve({});
  assert.strictEqual(await java.majorFor('velocity', '3.4.0'), 21);
  assert.deepStrictEqual(seen, []);
});

const ADOPTIUM = 'https://api.adoptium.net/v3/assets/latest/25/hotspot?architecture=x64&image_type=jre&os=linux&vendor=eclipse';
const LINK = 'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/OpenJDK25U-jre_x64_linux_hotspot_25.0.4.1_1.tar.gz';

test('the runtime is a Temurin JRE from Adoptium with its sha256', async () => {
  serve({ [ADOPTIUM]: [{ release_name: 'jdk-25.0.4.1+1', binary: { package: { link: LINK, checksum: HASH, name: 'OpenJDK25U-jre.tar.gz', size: 61718288 } } }] });
  assert.deepStrictEqual(await java.resolveRuntime(25, 'x64'), {
    major: 25, release: 'jdk-25.0.4.1+1', url: LINK, algo: 'sha256', hash: HASH, size: 61718288, file: 'OpenJDK25U-jre.tar.gz',
  });
});

test('a runtime from outside Adoptium on GitHub is refused', async () => {
  serve({ [ADOPTIUM]: [{ release_name: 'x', binary: { package: { link: 'https://github.com/evil/jre.tar.gz', checksum: HASH } } }] });
  await assert.rejects(java.resolveRuntime(25, 'x64'), /host/);
});

test('Node architectures map to Adoptium names; others and odd majors are refused', async () => {
  const seen = serve({});
  await assert.rejects(java.resolveRuntime(25, 'ia32'), /architecture/);
  await assert.rejects(java.resolveRuntime(7, 'x64'), /Java/);
  await assert.rejects(java.resolveRuntime(25, 'arm64'), /404/);
  assert.match(seen[0], /architecture=aarch64/);
});

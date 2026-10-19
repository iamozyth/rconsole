'use strict';
// Projects that publish one version per loader (BlueMap: 5.29-paper and
// 5.29-spigot, seconds apart): Paper servers get the Paper build.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const modrinth = require('../lib/modrinth');
const { Plugins } = require('../lib/plugins');

const ver = (id, number, loaders, date, type = 'release') =>
  ({ id, project_id: 'bluemapp', version_number: number, version_type: type, loaders, game_versions: ['26.3'], date_published: date, files: [] });
// Modrinth's order: newest first.
const VERSIONS = [
  ver('spig5290', '5.29-spigot', ['spigot'], '2026-10-10T17:42:43Z'),
  ver('papr5290', '5.29-paper', ['folia', 'paper', 'purpur'], '2026-10-10T17:42:34Z'),
  ver('spig5280', '5.28-spigot', ['spigot'], '2026-09-25T17:19:12Z'),
  ver('papr5280', '5.28-paper', ['folia', 'paper', 'purpur'], '2026-09-25T17:19:02Z'),
];
const newestFor = (loaders) => VERSIONS.find((v) => v.loaders.some((l) => loaders.includes(l)));
const SPIGOT_JAR = 'bluemap-5.29-spigot';
const sha = (t) => crypto.createHash('sha512').update(t).digest('hex');

global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const req = opts.body ? JSON.parse(opts.body) : null;
  let body = {};
  if (u.pathname.endsWith('/project/bluemap/version')) {
    const loaders = JSON.parse(u.searchParams.get('loaders'));
    body = VERSIONS.filter((v) => v.loaders.some((l) => loaders.includes(l)));
  } else if (u.pathname.endsWith('/version_files/update')) {
    const v = newestFor(req.loaders);
    body = Object.fromEntries(req.hashes.map((h) => [h, v]).filter(([, x]) => x));
  } else if (u.pathname.endsWith('/version_files')) {
    body = Object.fromEntries(req.hashes.filter((h) => h === sha(SPIGOT_JAR)).map((h) => [h, VERSIONS[0]]));
  } else if (u.pathname.endsWith('/projects')) {
    body = [{ id: 'bluemapp', slug: 'bluemap', title: 'BlueMap' }];
  }
  return { ok: true, status: 200, json: async () => body };
};

test('install on Paper picks the Paper build, on Spigot the Spigot one', async () => {
  assert.strictEqual((await modrinth.bestVersion('bluemap', '26.3', ['paper', 'spigot', 'bukkit'])).id, 'papr5290');
  assert.strictEqual((await modrinth.bestVersion('bluemap', '26.3', ['purpur', 'paper', 'spigot', 'bukkit'])).id, 'papr5290');
  assert.strictEqual((await modrinth.bestVersion('bluemap', '26.3', ['spigot', 'bukkit'])).id, 'spig5290');
});

test('a newer release still wins over a better loader', async () => {
  const old = [ver('spig5300', '5.30-spigot', ['spigot'], '2026-10-12T00:00:00Z'), ...VERSIONS];
  const saved = VERSIONS.splice(0, VERSIONS.length, ...old);
  try {
    assert.strictEqual((await modrinth.bestVersion('bluemap', '26.3', ['paper', 'spigot', 'bukkit'])).id, 'spig5300');
  } finally {
    VERSIONS.splice(0, VERSIONS.length, ...saved);
  }
});

test('updates prefer the Paper build and offer it for an installed Spigot build', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-loaders-'));
  fs.mkdirSync(path.join(dir, 'plugins'));
  fs.writeFileSync(path.join(dir, 'plugins', 'bluemap-5.29-spigot.jar'), SPIGOT_JAR);
  const platform = () => ({ id: 'paper', name: 'Paper', family: 'bukkit', loaders: ['paper', 'spigot', 'bukkit'], addons: { dir: 'plugins', kind: 'plugin', projectType: 'plugin' } });
  const p = new Plugins({ mcDir: dir, jobs: {}, pending: { add() {}, list: async () => [] }, log: () => {}, gameVersion: async () => '26.3', platform });
  const [bm] = (await p.list()).plugins;
  assert.strictEqual(bm.modrinth.versionId, 'spig5290');
  assert.deepStrictEqual([bm.update?.versionId, bm.update?.version], ['papr5290', '5.29-paper']);

  const latest = await modrinth.latestByHash([sha(SPIGOT_JAR)], '26.3', ['paper', 'spigot', 'bukkit']);
  assert.strictEqual(latest[sha(SPIGOT_JAR)].id, 'papr5290');
});

test('sameRelease and loaderRank', () => {
  assert.ok(modrinth.sameRelease(VERSIONS[0], VERSIONS[1]));
  assert.ok(!modrinth.sameRelease(VERSIONS[0], VERSIONS[2]));
  assert.strictEqual(modrinth.loaderRank(VERSIONS[1], ['paper', 'spigot']), 0);
  assert.strictEqual(modrinth.loaderRank(VERSIONS[0], ['paper', 'spigot']), 1);
  assert.strictEqual(modrinth.loaderRank(VERSIONS[0], ['fabric']), 1);
});

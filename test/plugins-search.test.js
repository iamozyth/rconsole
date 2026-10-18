'use strict';
// Plugin search and install: Bukkit plugins aren't held to the exact
// Minecraft version; mods are.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Plugins } = require('../lib/plugins');

const seen = [];
global.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  seen.push(decodeURIComponent(u.search));
  let body;
  if (u.pathname.endsWith('/search')) {
    body = { hits: [
      { project_id: 'aaaaaaaa', slug: 'essentialsx', title: 'EssentialsX', description: 'd', author: 'a', downloads: 1, versions: ['1.21.11', '26.1.2'] },
      { project_id: 'bbbbbbbb', slug: 'chunky', title: 'Chunky', description: 'd', author: 'a', downloads: 1, versions: ['26.1.2', '26.3'] },
    ] };
  } else if (u.pathname.includes('/project/aaaaaaaa/version')) {
    body = u.searchParams.get('game_versions') ? [] : [{ id: 'vvvvvvvv', version_type: 'release', game_versions: ['26.1.2'] }];
  } else body = {};
  return { ok: true, status: 200, json: async () => body };
};

function make(family) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-plugins-'));
  fs.mkdirSync(path.join(dir, family === 'bukkit' ? 'plugins' : 'mods'));
  const platform = () => ({ id: family === 'bukkit' ? 'paper' : 'fabric', name: 'X', family, loaders: [family === 'bukkit' ? 'paper' : 'fabric'], addons: { dir: family === 'bukkit' ? 'plugins' : 'mods', kind: 'plugin', projectType: 'plugin' } });
  const jobs = { run: async (kind, args) => ({ file: 'EssentialsX.jar', args }) };
  return new Plugins({ mcDir: dir, jobs, pending: { add() {}, list: async () => [] }, log: () => {}, gameVersion: async () => '26.3', platform });
}

test('bukkit: search offers plugins without a release for this version, exact matches first', async () => {
  seen.length = 0;
  const hits = await make('bukkit').search('ess');
  assert.deepStrictEqual(hits.map((h) => [h.title, h.exact, h.newestGame]), [['Chunky', true, '26.3'], ['EssentialsX', false, '26.1.2']]);
  assert.ok(!seen.some((s) => s.includes('versions:26.3')));
});

test('bukkit: install falls back to the newest release when none is for this version', async () => {
  const r = await make('bukkit').install('aaaaaaaa', 'u');
  assert.deepStrictEqual([r.args.versionId, r.exact, r.gameVersions], ['vvvvvvvv', false, ['26.1.2']]);
});

test('mods stay strict: search filters by version, install refuses', async () => {
  seen.length = 0;
  await make('fabric').search('ess');
  assert.ok(seen.some((s) => s.includes('versions:26.3')));
  await assert.rejects(make('fabric').install('aaaaaaaa', 'u'), /No version/);
});

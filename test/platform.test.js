'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fromLog, detect } = require('../lib/platform');
const { parseModManifest } = require('../lib/plugins');
const { zip } = require('./zip.test');

test('fromLog recognises each server software by its startup lines', () => {
  const cases = [
    ['[11:40:00] [Server thread/INFO]: This server is running Paper version 26.3-175-main@99867f8 (2026-10-01)', { id: 'paper', mcVersion: '26.3', build: 175 }],
    ['[11:40:00] [Server thread/INFO]: This server is running Folia version 1.21.4-12-ver/1.21.4@abc (2025-01-01)', { id: 'folia', mcVersion: '1.21.4', build: 12 }],
    ['This server is running Purpur version 1.21.4-2416-HEAD@abc (2025-01-01)', { id: 'purpur', mcVersion: '1.21.4', build: 2416 }],
    ['This server is running Pufferfish version 1.21.4-30-abc', { id: 'paper', fork: 'Pufferfish', build: 30 }],
    ['This server is running CraftBukkit version 4321-Spigot-a1b2c3-d4e5f6 (MC: 1.21.4) (Implementing API version 1.21.4-R0.1-SNAPSHOT)', { id: 'spigot', mcVersion: '1.21.4' }],
    ['[12:00:00] [main/INFO]: Loading Minecraft 1.21.4 with Fabric Loader 0.16.10', { id: 'fabric', mcVersion: '1.21.4', loaderVersion: '0.16.10' }],
    ['[12:00:00] [main/INFO]: Loading Minecraft 1.21.4 with Quilt Loader 0.28.0', { id: 'quilt', loaderVersion: '0.28.0' }],
    ['[12Oct2026 12:00:00.000] [main/INFO] [cpw.mods.modlauncher.Launcher/MODLAUNCHER]: ModLauncher running: args [--launchTarget, neoforgeserver, --fml.fmlVersion, 4.0.24, --fml.mcVersion, 1.21.1, --fml.neoForgeVersion, 21.1.77, --fml.neoFormVersion, 20240808.144430]\n[12Oct2026 12:00:05.000] [Server thread/INFO] [minecraft/DedicatedServer]: Starting minecraft server version 1.21.1', { id: 'neoforge', loaderVersion: '21.1.77', mcVersion: '1.21.1' }],
    ['ModLauncher running: args [--launchTarget, forgeserver, --fml.forgeVersion, 52.0.40, --fml.mcVersion, 1.21.1]\nStarting minecraft server version 1.21.1', { id: 'forge', loaderVersion: '52.0.40' }],
    ['[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.21.4', { id: null, mcVersion: '1.21.4' }],
  ];
  for (const [log, want] of cases) {
    const got = fromLog(log);
    for (const [k, v] of Object.entries(want)) assert.strictEqual(got[k], v, `${k} for: ${log.slice(0, 60)}`);
  }
});

test('detect falls back to files, and maps add-ons and loaders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-platform-'));
  fs.writeFileSync(path.join(dir, 'server.properties'), '');
  assert.strictEqual(detect(dir).id, 'vanilla');
  assert.strictEqual(detect(dir).addons, null);
  fs.writeFileSync(path.join(dir, 'fabric-server-launch.jar'), '');
  const fabric = detect(dir);
  assert.deepStrictEqual([fabric.id, fabric.addons.dir, fabric.addons.projectType, fabric.loaders], ['fabric', 'mods', 'mod', ['fabric']]);
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'logs', 'latest.log'), '[1] This server is running Paper version 26.3-175-main@x (y)\n');
  const paper = detect(dir);
  assert.deepStrictEqual([paper.id, paper.source, paper.addons.dir, paper.updates], ['paper', 'log', 'plugins', 'paper']);
});

test('mod manifests: Fabric, Quilt and NeoForge', () => {
  const fabric = parseModManifest(zip({ 'fabric.mod.json': JSON.stringify({ id: 'lithium', name: 'Lithium', version: '0.14.3', description: 'Optimises', authors: ['jellysquid3', { name: 'IMS' }] }) }));
  assert.deepStrictEqual(fabric, { name: 'Lithium', version: '0.14.3', description: 'Optimises', authors: ['jellysquid3', 'IMS'], website: undefined });
  const quilt = parseModManifest(zip({ 'quilt.mod.json': JSON.stringify({ quilt_loader: { id: 'q', version: '1.0', metadata: { name: 'Q Mod', contributors: { Alice: 'Owner' } } } }) }));
  assert.deepStrictEqual([quilt.name, quilt.version, quilt.authors], ['Q Mod', '1.0', ['Alice']]);
  const neo = parseModManifest(zip({
    'META-INF/neoforge.mods.toml': "modLoader=\"javafml\"\n[[mods]]\nmodId=\"jei\"\nversion=\"${file.jarVersion}\"\ndisplayName=\"Just Enough Items\"\nauthors=\"mezz\"\ndescription='''\nItem and recipe viewer\n'''\n",
    'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\nImplementation-Version: 19.21.0.247\n',
  }));
  assert.deepStrictEqual(neo, { name: 'Just Enough Items', version: '19.21.0.247', description: 'Item and recipe viewer', authors: ['mezz'] });
});

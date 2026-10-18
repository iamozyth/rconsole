'use strict';

// Which server software runs in MC_DIR: Paper and its forks, Spigot/Bukkit,
// Fabric, Quilt, Forge, NeoForge or vanilla. Decided from the startup lines
// of logs/latest.log first, then from files only that software creates.
// Used by rconsole (display, which features apply) and by the helper, which
// decides on its own where add-ons go and what may be installed.

const fs = require('fs');
const path = require('path');

// family: what kind of add-ons it loads. loaders: Modrinth loader names whose
// releases run on it, best match first. updates: automatic jar updates.
const PLATFORMS = {
  paper: { name: 'Paper', family: 'bukkit', loaders: ['paper', 'spigot', 'bukkit'], updates: 'paper' },
  folia: { name: 'Folia', family: 'bukkit', loaders: ['folia'], updates: 'folia' },
  purpur: { name: 'Purpur', family: 'bukkit', loaders: ['purpur', 'paper', 'spigot', 'bukkit'], updates: null },
  spigot: { name: 'Spigot', family: 'bukkit', loaders: ['spigot', 'bukkit'], updates: null },
  bukkit: { name: 'CraftBukkit', family: 'bukkit', loaders: ['bukkit'], updates: null },
  fabric: { name: 'Fabric', family: 'fabric', loaders: ['fabric'], updates: null },
  quilt: { name: 'Quilt', family: 'fabric', loaders: ['quilt', 'fabric'], updates: null },
  forge: { name: 'Forge', family: 'forge', loaders: ['forge'], updates: null },
  neoforge: { name: 'NeoForge', family: 'forge', loaders: ['neoforge'], updates: null },
  vanilla: { name: 'Vanilla', family: 'vanilla', loaders: [], updates: null },
};

const ADDONS = {
  bukkit: { dir: 'plugins', kind: 'plugin', projectType: 'plugin' },
  fabric: { dir: 'mods', kind: 'mod', projectType: 'mod' },
  forge: { dir: 'mods', kind: 'mod', projectType: 'mod' },
  vanilla: null,
};

const LOG_RULES = [
  // "This server is running Paper version 26.3-174-main@99867f8 (2026-...)"
  [/This server is running (Paper|Folia|Purpur) version (\d+(?:\.\d+)+)-(\d+)/, (m) => ({ id: m[1].toLowerCase(), mcVersion: m[2], build: Number(m[3]) })],
  // Forks we don't know report themselves the same way; they run Paper plugins.
  [/This server is running ([A-Za-z]+) version (\d+(?:\.\d+)+)-(\d+)/, (m) => ({ id: 'paper', fork: m[1], mcVersion: m[2], build: Number(m[3]) })],
  // "This server is running CraftBukkit version 4321-Spigot-abc-def (MC: 1.21.4)"
  [/This server is running CraftBukkit version \S*Spigot\S* \(MC: (\d+(?:\.\d+)+)\)/, (m) => ({ id: 'spigot', mcVersion: m[1] })],
  [/This server is running CraftBukkit version \S+ \(MC: (\d+(?:\.\d+)+)\)/, (m) => ({ id: 'bukkit', mcVersion: m[1] })],
  [/Loading Minecraft (\S+) with Quilt Loader (\S+)/, (m) => ({ id: 'quilt', mcVersion: m[1], loaderVersion: m[2] })],
  [/Loading Minecraft (\S+) with Fabric Loader (\S+)/, (m) => ({ id: 'fabric', mcVersion: m[1], loaderVersion: m[2] })],
  [/--fml\.neoForgeVersion,? (\S+)|NeoForge(?: version)? (\d+\.\d+\.\d+\S*)/, (m) => ({ id: 'neoforge', loaderVersion: (m[1] || m[2]).replace(/,$/, '') })],
  [/--fml\.forgeVersion,? (\S+)|MinecraftForge v(\d\S*)|Forge mod loading/, (m) => ({ id: 'forge', loaderVersion: (m[1] || m[2] || '').replace(/,$/, '') || null })],
];
const MC_VERSION_RE = /Starting minecraft server version (\S+)/;

function fromLog(text) {
  let found = null;
  for (const [re, make] of LOG_RULES) {
    const m = text.match(re);
    if (m) {
      found = make(m);
      break;
    }
  }
  const mc = text.match(MC_VERSION_RE)?.[1];
  if (found) return { ...found, mcVersion: found.mcVersion || mc || null, source: 'log' };
  return mc ? { id: null, mcVersion: mc, source: 'log' } : null;
}

const has = (dir, ...p) => {
  try {
    fs.lstatSync(path.join(dir, ...p));
    return true;
  } catch {
    return false;
  }
};

function fromFiles(mcDir) {
  if (has(mcDir, 'libraries', 'net', 'neoforged')) return 'neoforge';
  if (has(mcDir, 'libraries', 'net', 'minecraftforge')) return 'forge';
  if (has(mcDir, 'quilt-server-launch.jar') || has(mcDir, '.quilt')) return 'quilt';
  if (has(mcDir, 'fabric-server-launch.jar') || has(mcDir, '.fabric')) return 'fabric';
  if (has(mcDir, 'config', 'folia-global.yml')) return 'folia';
  if (has(mcDir, 'purpur.yml')) return 'purpur';
  if (has(mcDir, 'config', 'paper-global.yml') || has(mcDir, 'paper.yml')) return 'paper';
  if (has(mcDir, 'spigot.yml')) return 'spigot';
  if (has(mcDir, 'bukkit.yml')) return 'bukkit';
  if (has(mcDir, 'server.properties')) return 'vanilla';
  return null;
}

function readLogHead(mcDir) {
  try {
    const fd = fs.openSync(path.join(mcDir, 'logs', 'latest.log'), 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

// { id, name, family, mcVersion, build, loaderVersion, fork, addons, loaders, updates, source }
function detect(mcDir) {
  const log = fromLog(readLogHead(mcDir));
  const fileId = fromFiles(mcDir);
  const id = log?.id || fileId || 'vanilla';
  const spec = PLATFORMS[id];
  return {
    id,
    name: log?.fork || spec.name,
    family: spec.family,
    mcVersion: log?.mcVersion || null,
    build: log?.build ?? null,
    loaderVersion: log?.loaderVersion || null,
    fork: log?.fork || null,
    addons: ADDONS[spec.family],
    loaders: spec.loaders,
    updates: spec.updates,
    source: log?.id ? 'log' : fileId ? 'files' : 'default',
  };
}

// Cached by latest.log identity; the platform only changes with a restart.
function detector(mcDir, { ttlMs = 60 * 1000 } = {}) {
  let cache = null;
  return () => {
    let key = '';
    try {
      const st = fs.statSync(path.join(mcDir, 'logs', 'latest.log'));
      key = `${st.ino}:${st.size > 256 * 1024 ? 'big' : st.size}`;
    } catch {}
    // A small log grows with every line; while it does (startup), look
    // again at most every few seconds rather than on every call.
    const sameLog = cache && cache.key.split(':')[0] === key.split(':')[0];
    if (cache && Date.now() - cache.at < (cache.key === key ? ttlMs : sameLog ? Math.min(5000, ttlMs) : 0)) return cache.value;
    cache = { key, at: Date.now(), value: detect(mcDir) };
    return cache.value;
  };
}

module.exports = { detect, detector, fromLog, fromFiles, PLATFORMS, ADDONS };

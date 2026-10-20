'use strict';

// Modrinth modpacks (.mrpack, https://support.modrinth.com/en/articles/8802351):
// a zip with modrinth.index.json, which lists the mods to download (with
// hashes) and the loader they need, plus overrides/ and server-overrides/
// folders copied over the server. Read in the helper; the pack comes from
// Modrinth but whoever published it is not trusted, so every path, host,
// hash and version in it is checked here.

const { entryParts } = require('./archive');
const { VERSION_RE, LOADER_RE, versionKey } = require('./distributions');

// Where the format allows pack files to be downloaded from.
const FILE_HOSTS = new Set(['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']);
const MAX_FILES = 5000;
// The loader dependency and the distribution that installs it.
const LOADERS = { 'fabric-loader': 'fabric', 'quilt-loader': 'quilt', forge: 'forge', neoforge: 'neoforge' };
// rconsole writes these itself; a pack can't replace them. server.properties
// from a pack is merged (see mergeProperties).
const PROTECTED = new Set(['instance.json', 'eula.txt', 'server.properties', 'whitelist.json', 'ops.json', '.rconsole-previous']);
// Keys of server.properties a pack may not set: rconsole's RCON and port.
const OWN_KEYS = new Set(['server-port', 'server-ip', 'enable-rcon', 'rcon.port', 'rcon.password', 'online-mode', 'query.port', 'enable-query']);

const fail = (msg) => {
  throw new Error(msg);
};

// A relative path inside the server folder, as parts. Refuses anything that
// could leave it or replace what rconsole writes.
function safePath(raw) {
  let parts;
  try {
    parts = entryParts(raw);
  } catch {
    fail(`The modpack contains an unsafe path (${JSON.stringify(String(raw).slice(0, 120))})`);
  }
  if (!parts.length) fail('The modpack contains an empty path');
  if (PROTECTED.has(parts[0])) fail(`The modpack may not replace ${parts[0]}`);
  return parts;
}

function downloadUrl(list) {
  for (const raw of Array.isArray(list) ? list : []) {
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:' && FILE_HOSTS.has(url.hostname)) return url.href;
    } catch {}
  }
  return null;
}

// What a pack installs on a server: the parsed index, or an error naming
// what's wrong. Files the pack marks as client only are left out.
function parseIndex(text) {
  let index;
  try {
    index = JSON.parse(text);
  } catch {
    fail('modrinth.index.json is not valid JSON');
  }
  if (index?.formatVersion !== 1) fail(`Unsupported modpack format ${index?.formatVersion}`);
  if (index.game !== 'minecraft') fail(`This modpack is for ${index.game}, not Minecraft`);
  const deps = index.dependencies || {};
  const mc = String(deps.minecraft || '');
  if (!VERSION_RE.test(mc)) fail(`The modpack names no usable Minecraft version (${mc || 'none'})`);
  const loaders = Object.keys(deps).filter((k) => k !== 'minecraft');
  const unknown = loaders.find((k) => !LOADERS[k]);
  if (unknown) fail(`The modpack needs ${unknown}, which rconsole can't install`);
  if (loaders.length > 1) fail(`The modpack names more than one loader (${loaders.join(', ')})`);
  const distribution = loaders.length ? LOADERS[loaders[0]] : 'vanilla';
  const loaderVersion = loaders.length ? String(deps[loaders[0]]) : null;
  if (loaderVersion !== null && !LOADER_RE.test(loaderVersion)) fail(`Invalid ${loaders[0]} version ${loaderVersion}`);
  // rconsole installs Forge from 1.17 on (its installer differs before).
  if (distribution === 'forge' && versionKey(mc) < versionKey('1.17')) fail('Forge modpacks for Minecraft before 1.17 aren\'t supported');

  if (!Array.isArray(index.files)) fail('modrinth.index.json has no file list');
  if (index.files.length > MAX_FILES) fail(`The modpack lists more than ${MAX_FILES} files`);
  const files = [];
  const seen = new Set();
  let clientOnly = 0;
  for (const f of index.files) {
    if (f?.env?.server === 'unsupported') {
      clientOnly++;
      continue;
    }
    const parts = safePath(f?.path);
    const key = parts.join('/');
    if (seen.has(key)) fail(`The modpack lists ${key} twice`);
    seen.add(key);
    const sha512 = String(f.hashes?.sha512 || '').toLowerCase();
    if (!/^[a-f0-9]{128}$/.test(sha512)) fail(`${key} has no sha512 in the modpack`);
    const url = downloadUrl(f.downloads);
    if (!url) fail(`${key} isn't hosted where modpacks may download from (Modrinth, GitHub, GitLab)`);
    const size = Number(f.fileSize);
    files.push({ path: key, parts, url, sha512, size: Number.isFinite(size) && size >= 0 ? size : 0, optional: f?.env?.server === 'optional' });
  }
  return {
    name: String(index.name || 'Modpack').replace(/[\u0000-\u001f]/g, '').slice(0, 64),
    version: String(index.versionId || '').replace(/[\u0000-\u001f]/g, '').slice(0, 64),
    mc, distribution, loaderVersion, files, clientOnly,
    bytes: files.reduce((n, f) => n + f.size, 0),
  };
}

// The pack's server.properties without the keys rconsole owns.
function mergeProperties(packProps) {
  return Object.fromEntries(Object.entries(packProps).filter(([k]) => !OWN_KEYS.has(k)));
}

// The .mrpack file of a Modrinth version: hosted by Modrinth, with a sha512.
function packFile(version, api) {
  const file = (version.files || []).find((f) => f.primary && /\.mrpack$/i.test(f.filename)) || (version.files || []).find((f) => /\.mrpack$/i.test(f.filename));
  if (!file) fail('This version has no .mrpack file');
  const url = new URL(file.url);
  const mirror = new URL(api);
  const trusted = (url.protocol === 'https:' && /(^|\.)modrinth\.com$/.test(url.hostname)) || (url.protocol === mirror.protocol && url.host === mirror.host);
  if (!trusted) fail(`Unexpected download host ${url.hostname}`);
  if (!/^[a-f0-9]{128}$/.test(file.hashes?.sha512 || '')) fail('The modpack download has no sha512');
  return { url: url.href, sha512: file.hashes.sha512, size: Number(file.size) || null };
}

// The distribution a Modrinth version's loaders map to, for the form and
// for checking a wish before the pack is downloaded.
function distributionOf(loaders = []) {
  const map = { fabric: 'fabric', quilt: 'quilt', forge: 'forge', neoforge: 'neoforge', minecraft: 'vanilla' };
  const found = loaders.map((l) => map[l]).filter(Boolean);
  return found[0] || null;
}

module.exports = { parseIndex, safePath, mergeProperties, packFile, distributionOf, FILE_HOSTS, PROTECTED };

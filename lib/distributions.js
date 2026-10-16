'use strict';

// Server distributions rconsole can install: where versions and builds come
// from, and how a download is resolved and verified. Used by rconsole (lists
// for the UI) and by the helper, which resolves the download again itself and
// never takes a URL or checksum from rconsole.
//
// resolve() refuses anything without a publisher checksum or from a host
// other than the publisher's own.

const crypto = require('crypto');

const USER_AGENT = 'rconsole (https://github.com/iamozyth/rconsole)';
// FILL_API and MOJANG_MANIFEST exist for testing against a local mirror;
// downloads must then come from that host or the publisher's.
const FILL = process.env.FILL_API || 'https://fill.papermc.io/v3/projects';
const MANIFEST = process.env.MOJANG_MANIFEST || 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

const VERSION_RE = /^\d+(\.\d+)+$/;
const versionKey = (v) => v.split('.').map((n) => n.padStart(6, '0')).join('.');
const newestFirst = (list) => [...new Set(list)].filter((v) => VERSION_RE.test(v)).sort((a, b) => versionKey(b).localeCompare(versionKey(a)));

const PAPERMC_HOST = /(^|\.)papermc\.io$/;
const MOJANG_HOST = /(^|\.)mojang\.com$/;

async function get(url, as = 'json') {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: as === 'json' ? 'application/json' : '*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return as === 'json' ? res.json() : res.text();
}

// A download URL is trusted when it is HTTPS on the publisher's host, or on
// the host of the API mirror configured for tests.
function trustedUrl(raw, hostRe, api) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid download URL');
  }
  const mirror = new URL(api);
  if ((url.protocol === 'https:' && hostRe.test(url.hostname)) || (url.protocol === mirror.protocol && url.host === mirror.host)) return url.href;
  throw new Error(`Unexpected download host ${url.hostname}`);
}

// --- PaperMC (Fill v3): Paper, Folia, Velocity -------------------------------

function papermc(project) {
  const api = `${FILL}/${project}`;
  return {
    async versions() {
      const data = await get(api);
      return newestFirst(Object.values(data.versions || {}).flat());
    },
    async builds(version) {
      const data = await get(`${api}/versions/${version}/builds`);
      return (Array.isArray(data) ? data : data.builds || [])
        .map((b) => ({ id: Number(b.id), channel: b.channel || null, time: b.time ?? null }))
        .filter((b) => Number.isInteger(b.id))
        .sort((a, b) => b.id - a.id);
    },
    async resolve(version, build) {
      if (build == null) {
        const [newest] = await this.builds(version);
        if (!newest) throw new Error(`No builds for ${version}`);
        build = newest.id;
      }
      const data = await get(`${api}/versions/${version}/builds/${build}`);
      const dl = data.downloads?.['server:default'];
      const hash = dl?.checksums?.sha256;
      if (!dl?.url || !/^[a-f0-9]{64}$/.test(hash || '')) throw new Error(`${version} #${build} has no verifiable download`);
      return { build, url: trustedUrl(dl.url, PAPERMC_HOST, FILL), algo: 'sha256', hash, size: dl.size ?? null, file: dl.name || `${project}-${version}-${build}.jar`, javaMajor: null };
    },
  };
}

// --- Mojang: vanilla ---------------------------------------------------------

const vanilla = {
  async versions() {
    const data = await get(MANIFEST);
    return newestFirst((data.versions || []).filter((v) => v.type === 'release').map((v) => v.id));
  },
  async builds() {
    return [];
  },
  // The version file is checked against the manifest's SHA-1, and the server
  // jar against the version file's.
  async resolve(version) {
    const entry = (await get(MANIFEST)).versions?.find((v) => v.id === version && v.type === 'release');
    if (!entry || !/^[a-f0-9]{40}$/.test(entry.sha1 || '')) throw new Error(`Minecraft ${version} not found`);
    const text = await get(trustedUrl(entry.url, MOJANG_HOST, MANIFEST), 'text');
    if (crypto.createHash('sha1').update(text).digest('hex') !== entry.sha1) throw new Error(`Version file for ${version} doesn't match its checksum`);
    const meta = JSON.parse(text);
    const dl = meta.downloads?.server;
    if (!dl?.url || !/^[a-f0-9]{40}$/.test(dl.sha1 || '')) throw new Error(`Minecraft ${version} has no verifiable server download`);
    const java = Number(meta.javaVersion?.majorVersion);
    return { build: null, url: trustedUrl(dl.url, MOJANG_HOST, MANIFEST), algo: 'sha1', hash: dl.sha1, size: dl.size ?? null, file: 'server.jar', javaMajor: Number.isInteger(java) ? java : null };
  },
};

// --- catalog -----------------------------------------------------------------

// kind: server (runs worlds) or proxy (forwards players to servers).
// platform: the id lib/platform.js detects once it runs. verify: checksum
// the publisher provides, shown in the UI.
const DISTRIBUTIONS = {
  vanilla: { name: 'Vanilla', kind: 'server', platform: 'vanilla', verify: 'sha1', source: vanilla },
  paper: { name: 'Paper', kind: 'server', platform: 'paper', verify: 'sha256', source: papermc('paper') },
  folia: { name: 'Folia', kind: 'server', platform: 'folia', verify: 'sha256', source: papermc('folia') },
  velocity: { name: 'Velocity', kind: 'proxy', platform: 'velocity', verify: 'sha256', source: papermc('velocity') },
};

function spec(id) {
  if (!Object.hasOwn(DISTRIBUTIONS, String(id))) throw new Error(`Unknown distribution ${id}`);
  return DISTRIBUTIONS[id];
}

function checkVersion(version) {
  if (!VERSION_RE.test(String(version))) throw new Error('Invalid version');
  return String(version);
}

const list = () => Object.entries(DISTRIBUTIONS).map(([id, d]) => ({ id, name: d.name, kind: d.kind, platform: d.platform, verify: d.verify }));

const versions = async (id) => spec(id).source.versions();

async function builds(id, version) {
  const s = spec(id);
  return s.source.builds(checkVersion(version));
}

// { distribution, version, build, url, algo, hash, size, file, install, javaMajor }
async function resolve(id, version, build = null) {
  const s = spec(id);
  checkVersion(version);
  if (build != null && (!Number.isInteger(build) || build < 1)) throw new Error('Invalid build');
  const r = await s.source.resolve(version, build);
  return { distribution: id, version, build: r.build, url: r.url, algo: r.algo, hash: r.hash, size: r.size, file: r.file, install: 'jar', javaMajor: r.javaMajor };
}

module.exports = { list, versions, builds, resolve, USER_AGENT };

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
const PURPUR_API = process.env.PURPUR_API || 'https://api.purpurmc.org/v2/purpur';
const PURPUR_HOST = /(^|\.)purpurmc\.org$/;
const FABRIC_META = process.env.FABRIC_META || 'https://meta.fabricmc.net/v2/versions';
const FABRIC_HOST = /(^|\.)fabricmc\.net$/;
const QUILT_META = process.env.QUILT_META || 'https://meta.quiltmc.org/v3/versions';
const QUILT_MAVEN = process.env.QUILT_MAVEN || 'https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer';
const QUILT_HOST = /(^|\.)quiltmc\.org$/;
const NEO_MAVEN = process.env.NEOFORGE_MAVEN || 'https://maven.neoforged.net/releases/net/neoforged/neoforge';
const NEO_HOST = /(^|\.)neoforged\.net$/;
const FORGE_MAVEN = process.env.FORGE_MAVEN || 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const FORGE_PROMOS = process.env.FORGE_PROMOS || 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_HOST = /(^|\.)minecraftforge\.net$/;
// Loader versions: 0.19.5, 64.1.0, 26.3.0.86. No spaces, slashes or leading dashes.
const LOADER_RE = /^\d[0-9A-Za-z.+-]{0,63}$/;

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

// --- Purpur ---------------------------------------------------------------------

// The API publishes MD5 only; the UI shows that.
const purpur = {
  async versions() {
    return newestFirst((await get(PURPUR_API)).versions || []);
  },
  async builds(version) {
    const data = await get(`${PURPUR_API}/${version}`);
    return (data.builds?.all || []).map(Number).filter(Number.isInteger).sort((a, b) => b - a).map((id) => ({ id, channel: null, time: null }));
  },
  async resolve(version, build) {
    const data = await get(`${PURPUR_API}/${version}/${build ?? 'latest'}`);
    const id = Number(data.build);
    if (data.result !== 'SUCCESS' || !Number.isInteger(id) || !/^[a-f0-9]{32}$/.test(data.md5 || '')) throw new Error(`Purpur ${version} #${build ?? 'latest'} has no verifiable download`);
    const url = trustedUrl(`${PURPUR_API}/${version}/${id}/download`, PURPUR_HOST, PURPUR_API);
    return { build: id, url, algo: 'md5', hash: data.md5, size: null, file: `purpur-${version}-${id}.jar`, javaMajor: null };
  },
};

// --- Maven installers: Fabric, Quilt, NeoForge, Forge ------------------------------

// The SHA-256 Maven publishes next to the file, on the same host.
async function mavenSha256(url) {
  const text = String(await get(`${url}.sha256`, 'text')).trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`${url.split('/').pop()} has no verifiable download`);
  return text;
}

async function installer({ url, hostRe, api, loader, args }) {
  const href = trustedUrl(url, hostRe, api);
  return { build: loader, url: href, algo: 'sha256', hash: await mavenSha256(href), size: null, file: href.split('/').pop(), javaMajor: null, install: 'installer', installArgs: args };
}

const isStable = (v) => /^\d+(\.\d+)+$/.test(v);

const fabric = {
  async versions() {
    return newestFirst((await get(`${FABRIC_META}/game`)).filter((v) => v.stable).map((v) => v.version));
  },
  async builds() {
    return (await get(`${FABRIC_META}/loader`)).filter((l) => l.stable && LOADER_RE.test(l.version)).map((l) => ({ id: l.version, channel: 'stable', time: null }));
  },
  async resolve(version, loader) {
    loader ??= (await this.builds())[0]?.id;
    if (!loader) throw new Error('No stable Fabric loader');
    const inst = (await get(`${FABRIC_META}/installer`)).find((i) => i.stable);
    if (!inst?.url) throw new Error('No stable Fabric installer');
    return installer({ url: inst.url, hostRe: FABRIC_HOST, api: FABRIC_META, loader, args: ['server', '-mcversion', version, '-loader', loader, '-downloadMinecraft'] });
  },
};

const quilt = {
  async versions() {
    return newestFirst((await get(`${QUILT_META}/game`)).filter((v) => v.stable).map((v) => v.version));
  },
  async builds() {
    return newestFirst((await get(`${QUILT_META}/loader`)).map((l) => l.version)).map((id) => ({ id, channel: 'stable', time: null }));
  },
  async resolve(version, loader) {
    loader ??= (await this.builds())[0]?.id;
    if (!loader) throw new Error('No stable Quilt loader');
    const release = String(await get(`${QUILT_MAVEN}/maven-metadata.xml`, 'text')).match(/<release>([^<]+)<\/release>/)?.[1];
    if (!release || !isStable(release)) throw new Error('No Quilt installer release');
    const url = `${QUILT_MAVEN}/${release}/quilt-installer-${release}.jar`;
    return installer({ url, hostRe: QUILT_HOST, api: QUILT_MAVEN, loader, args: ['install', 'server', version, loader, '--download-server', '--install-dir=.'] });
  },
};

// NeoForge versions encode the Minecraft version: 21.1.262 is 1.21.1,
// 21.0.5 is 1.21; from 26.x on, 26.1.2.121 is 26.1.2 and 26.3.0.86 is 26.3.
function neoToMc(v) {
  const p = v.split('.');
  if (Number(p[0]) >= 26 && p.length === 4) return p[2] === '0' ? `${p[0]}.${p[1]}` : `${p[0]}.${p[1]}.${p[2]}`;
  if (p.length === 3) return p[1] === '0' ? `1.${p[0]}` : `1.${p[0]}.${p[1]}`;
  return null;
}

const neoforge = {
  async all() {
    const xml = String(await get(`${NEO_MAVEN}/maven-metadata.xml`, 'text'));
    return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]).filter(isStable);
  },
  async versions() {
    return newestFirst((await this.all()).map(neoToMc).filter(Boolean));
  },
  async builds(version) {
    return newestFirst((await this.all()).filter((v) => neoToMc(v) === version)).map((id) => ({ id, channel: 'release', time: null }));
  },
  async resolve(version, build) {
    build ??= (await this.builds(version))[0]?.id;
    if (!build || neoToMc(build) !== version) throw new Error(`No NeoForge release for ${version}`);
    return installer({ url: `${NEO_MAVEN}/${build}/neoforge-${build}-installer.jar`, hostRe: NEO_HOST, api: NEO_MAVEN, loader: build, args: ['--installServer'] });
  },
};

// Forge: the promotions list names a recommended and a latest build per
// Minecraft version; recommended wins.
const forge = {
  async promos() {
    return (await get(FORGE_PROMOS)).promos || {};
  },
  async versions() {
    return newestFirst(Object.keys(await this.promos()).map((k) => k.replace(/-(latest|recommended)$/, '')));
  },
  async builds(version) {
    const p = await this.promos();
    return [...new Set([p[`${version}-recommended`], p[`${version}-latest`]].filter(Boolean))].map((id, i) => ({ id, channel: i === 0 && p[`${version}-recommended`] ? 'recommended' : 'latest', time: null }));
  },
  async resolve(version, build) {
    build ??= (await this.builds(version))[0]?.id;
    if (!build || !LOADER_RE.test(build)) throw new Error(`No Forge build for ${version}`);
    const full = `${version}-${build}`;
    return installer({ url: `${FORGE_MAVEN}/${full}/forge-${full}-installer.jar`, hostRe: FORGE_HOST, api: FORGE_MAVEN, loader: build, args: ['--installServer'] });
  },
};

// --- catalog -----------------------------------------------------------------

// kind: server (runs worlds) or proxy (forwards players to servers).
// platform: the id lib/platform.js detects once it runs. verify: checksum
// the publisher provides, shown in the UI; sha256-maven is published next to
// the file on the same host, not by a separate API. build: an integer for
// PaperMC and Purpur, the loader version for Fabric, Quilt, Forge, NeoForge.
const DISTRIBUTIONS = {
  vanilla: { name: 'Vanilla', kind: 'server', platform: 'vanilla', verify: 'sha1', source: vanilla },
  paper: { name: 'Paper', kind: 'server', platform: 'paper', verify: 'sha256', source: papermc('paper') },
  folia: { name: 'Folia', kind: 'server', platform: 'folia', verify: 'sha256', source: papermc('folia') },
  purpur: { name: 'Purpur', kind: 'server', platform: 'purpur', verify: 'md5', source: purpur },
  fabric: { name: 'Fabric', kind: 'server', platform: 'fabric', verify: 'sha256-maven', source: fabric },
  quilt: { name: 'Quilt', kind: 'server', platform: 'quilt', verify: 'sha256-maven', source: quilt },
  forge: { name: 'Forge', kind: 'server', platform: 'forge', verify: 'sha256-maven', source: forge },
  neoforge: { name: 'NeoForge', kind: 'server', platform: 'neoforge', verify: 'sha256-maven', source: neoforge },
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

// { distribution, version, build, url, algo, hash, size, file, install, installArgs, javaMajor }
// install: 'jar' is the server itself; 'installer' runs once in the server
// folder with installArgs (fixed per distribution, built here) and leaves the
// server behind.
async function resolve(id, version, build = null) {
  const s = spec(id);
  checkVersion(version);
  if (build != null && !(Number.isInteger(build) && build > 0) && !(typeof build === 'string' && LOADER_RE.test(build))) throw new Error('Invalid build');
  const r = await s.source.resolve(version, build);
  return {
    distribution: id, version, build: r.build, url: r.url, algo: r.algo, hash: r.hash, size: r.size, file: r.file,
    install: r.install || 'jar', installArgs: r.installArgs || [], javaMajor: r.javaMajor,
  };
}

module.exports = { list, versions, builds, resolve, USER_AGENT };

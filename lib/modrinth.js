'use strict';

// Modrinth API v2 (https://docs.modrinth.com/api): identify installed plugins
// by file hash, check for updates, search, and resolve verified downloads.

const API = process.env.MODRINTH_API || 'https://api.modrinth.com/v2';
const USER_AGENT = 'iamozyth/rconsole (https://github.com/iamozyth/rconsole)';
// Default: Bukkit-family plugins. Callers pass the loaders of the detected platform.
const LOADERS = ['paper', 'spigot', 'bukkit', 'purpur', 'folia'];
const DOWNLOAD_HOST = /(^|\.)modrinth\.com$/;
const ID_RE = /^[A-Za-z0-9]{8}$/;

async function call(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Modrinth API ${res.status} for ${pathname.split('?')[0]}`);
  return res.json();
}

const q = (o) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])).toString();

// { sha512: version } for every hash Modrinth knows.
const versionsByHash = (hashes) => (hashes.length ? call('/version_files', { method: 'POST', body: { hashes, algorithm: 'sha512' } }) : {});

// Projects like BlueMap publish one version per loader (5.29-paper,
// 5.29-spigot) seconds apart, so "newest" alone picks whichever came last.
// loaderRank: index of the version's best loader in the server's preference
// order. sameRelease: the loader variants of one release.
const VARIANT_RE = /\b(paper|spigot|bukkit|purpur|folia|fabric|quilt|forge|neoforge|sponge|velocity|bungeecord|waterfall)\b/g;
const loaderRank = (v, loaders) => Math.min(...(v.loaders || []).map((l) => loaders.indexOf(l)).filter((i) => i >= 0), loaders.length);
const releaseKey = (v) => String(v.version_number || '').toLowerCase().replace(VARIANT_RE, '').replace(/[^a-z0-9.]+/g, '');
const sameRelease = (a, b) => (releaseKey(a) && releaseKey(b)
  ? releaseKey(a) === releaseKey(b)
  : Math.abs(Date.parse(a.date_published) - Date.parse(b.date_published)) < 60 * 60 * 1000);

// The newest release, as the variant for the most preferred loader.
function pick(list, loaders) {
  const vs = list.filter(Boolean);
  if (!vs.length) return null;
  const newest = vs.reduce((a, b) => (Date.parse(b.date_published) > Date.parse(a.date_published) ? b : a));
  return vs.filter((v) => v === newest || sameRelease(v, newest))
    .sort((a, b) => loaderRank(a, loaders) - loaderRank(b, loaders) || Date.parse(b.date_published) - Date.parse(a.date_published))[0];
}

// { sha512: newest compatible version } for the given Minecraft version.
// Asked per loader, as Modrinth would otherwise answer with whichever loader
// variant was uploaded last.
async function latestByHash(hashes, gameVersion, loaders = LOADERS) {
  if (!hashes.length) return {};
  const per = await Promise.all(loaders.map((l) =>
    call('/version_files/update', { method: 'POST', body: { hashes, algorithm: 'sha512', loaders: [l], ...(gameVersion ? { game_versions: [gameVersion] } : {}) } })));
  const out = {};
  for (const h of hashes) {
    const v = pick(per.map((r) => r[h]), loaders);
    if (v) out[h] = v;
  }
  return out;
}

const projects = (ids) => (ids.length ? call(`/projects?${q({ ids })}`) : []);

// strict: only projects with a release for gameVersion (mods); otherwise
// every project for these loaders, with the game versions it supports.
async function search(query, gameVersion, { loaders = LOADERS, projectType = 'plugin', strict = true } = {}) {
  const facets = [[`project_type:${projectType}`], loaders.map((l) => `categories:${l}`)];
  if (gameVersion && strict) facets.push([`versions:${gameVersion}`]);
  const r = await call(`/search?${q({ query: String(query).slice(0, 100), facets, limit: '20', index: 'relevance' })}`);
  return r.hits.map((h) => ({
    id: h.project_id, slug: h.slug, title: h.title, description: h.description, author: h.author,
    downloads: h.downloads, icon: h.icon_url || null, latest: h.latest_version || null,
    gameVersions: Array.isArray(h.versions) ? h.versions.filter((v) => /^\d+(\.\d+)+$/.test(v)) : [],
  }));
}

// Newest version of a project that runs on this server.
async function bestVersion(projectId, gameVersion, loaders = LOADERS) {
  if (!ID_RE.test(projectId) && !/^[a-z0-9_-]{2,64}$/i.test(projectId)) throw new Error('Invalid project id');
  const list = await call(`/project/${encodeURIComponent(projectId)}/version?${q({ loaders, ...(gameVersion ? { game_versions: [gameVersion] } : {}) })}`);
  const releases = list.filter((v) => v.version_type === 'release');
  return pick(releases.length ? releases : list, loaders);
}

// The file to install for a version, refusing anything not hosted by Modrinth
// or without a sha512.
function primaryFile(version) {
  const file = version.files.find((f) => f.primary) || version.files[0];
  if (!file) throw new Error('This version has no files');
  const url = new URL(file.url);
  const api = new URL(API);
  const trusted = (url.protocol === 'https:' && DOWNLOAD_HOST.test(url.hostname)) || (url.protocol === api.protocol && url.host === api.host);
  if (!trusted) throw new Error(`Unexpected download host ${url.hostname}`);
  if (!/^[a-f0-9]{128}$/.test(file.hashes?.sha512 || '')) throw new Error('Download has no sha512');
  if (!/^[A-Za-z0-9._+-]{1,100}\.jar$/.test(file.filename)) throw new Error(`Unexpected file name ${file.filename}`);
  return { url: url.href, sha512: file.hashes.sha512, filename: file.filename, size: file.size };
}

async function version(versionId) {
  if (!ID_RE.test(versionId)) throw new Error('Invalid version id');
  return call(`/version/${versionId}`);
}

module.exports = { versionsByHash, loaderRank, sameRelease, latestByHash, projects, search, bestVersion, primaryFile, version, USER_AGENT, ID_RE };

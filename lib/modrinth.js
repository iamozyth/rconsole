'use strict';

// Modrinth API v2 (https://docs.modrinth.com/api): identify installed plugins
// by file hash, check for updates, search, and resolve verified downloads.

const API = process.env.MODRINTH_API || 'https://api.modrinth.com/v2';
const USER_AGENT = 'iamozyth/rconsole (https://github.com/iamozyth/rconsole)';
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

// { sha512: newest compatible version } for the given Minecraft version.
const latestByHash = (hashes, gameVersion) =>
  hashes.length ? call('/version_files/update', { method: 'POST', body: { hashes, algorithm: 'sha512', loaders: LOADERS, ...(gameVersion ? { game_versions: [gameVersion] } : {}) } }) : {};

const projects = (ids) => (ids.length ? call(`/projects?${q({ ids })}`) : []);

async function search(query, gameVersion) {
  const facets = [['project_type:plugin'], LOADERS.map((l) => `categories:${l}`)];
  if (gameVersion) facets.push([`versions:${gameVersion}`]);
  const r = await call(`/search?${q({ query: String(query).slice(0, 100), facets, limit: '20', index: 'relevance' })}`);
  return r.hits.map((h) => ({
    id: h.project_id, slug: h.slug, title: h.title, description: h.description, author: h.author,
    downloads: h.downloads, icon: h.icon_url || null, latest: h.latest_version || null,
  }));
}

// Newest version of a project that runs on this server.
async function bestVersion(projectId, gameVersion) {
  if (!ID_RE.test(projectId) && !/^[a-z0-9_-]{2,64}$/i.test(projectId)) throw new Error('Invalid project id');
  const list = await call(`/project/${encodeURIComponent(projectId)}/version?${q({ loaders: LOADERS, ...(gameVersion ? { game_versions: [gameVersion] } : {}) })}`);
  return list.find((v) => v.version_type === 'release') || list[0] || null;
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

module.exports = { versionsByHash, latestByHash, projects, search, bestVersion, primaryFile, version, USER_AGENT, ID_RE };

'use strict';

// PaperMC downloads API (Fill v3): https://fill.papermc.io

// PAPER_API exists for testing against a local mirror; downloads must then
// come from that host or papermc.io.
const API = process.env.PAPER_API || 'https://fill.papermc.io/v3/projects/paper';
const USER_AGENT = 'rconsole (https://github.com/iamozyth/rconsole)';
const DOWNLOAD_HOST = /(^|\.)papermc\.io$/;

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`PaperMC API ${res.status} for ${url}`);
  return res.json();
}

const versionKey = (v) => v.split('.').map((n) => n.padStart(6, '0')).join('.');

// Release versions only (no -pre/-rc), newest first.
async function versions() {
  const data = await get(API);
  const all = Object.values(data.versions || {}).flat();
  return [...new Set(all)].filter((v) => /^\d+(\.\d+)+$/.test(v)).sort((a, b) => versionKey(b).localeCompare(versionKey(a)));
}

async function builds(version) {
  const data = await get(`${API}/versions/${encodeURIComponent(version)}/builds`);
  const list = Array.isArray(data) ? data : data.builds || [];
  return list
    .map((b) => ({ id: Number(b.id), channel: b.channel, time: b.time ?? b.createdAt ?? null }))
    .filter((b) => Number.isInteger(b.id))
    .sort((a, b) => b.id - a.id);
}

// Resolves the server jar of one build, refusing anything without a checksum.
async function download(version, id) {
  const build = await get(`${API}/versions/${encodeURIComponent(version)}/builds/${id}`);
  const dl = build.downloads?.['server:default'];
  const sha256 = dl?.checksums?.sha256;
  if (!dl?.url || !/^[a-f0-9]{64}$/.test(sha256 || '')) throw new Error(`Build ${version} #${id} has no verifiable server download`);
  const url = new URL(dl.url);
  const api = new URL(API);
  const trusted = (url.protocol === 'https:' && DOWNLOAD_HOST.test(url.hostname)) || (url.protocol === api.protocol && url.host === api.host);
  if (!trusted) throw new Error(`Unexpected download host ${url.hostname}`);
  return { url: url.href, sha256, size: dl.size ?? null, name: dl.name ?? null };
}

module.exports = { versions, builds, download, USER_AGENT };

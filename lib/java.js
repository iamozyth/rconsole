'use strict';

// Java for the servers rconsole installs: which major version a server needs
// (from Mojang's version file), and the Eclipse Temurin JRE that provides it
// (Adoptium API, SHA-256). No system Java needed; versions sit side by side.

const distributions = require('./distributions');

const API = process.env.ADOPTIUM_API || 'https://api.adoptium.net/v3';
const ARCH = { x64: 'x64', arm64: 'aarch64' };
// Release assets of Adoptium's own repositories only.
const DOWNLOAD_RE = /^https:\/\/github\.com\/adoptium\/temurin\d+-binaries\/releases\/download\//;

// Proxies run their own code, not Minecraft's; Velocity 3.x and later need 21.
const PROXY_JAVA = 21;
const known = new Map(); // Minecraft version -> Java major; fixed once released

async function majorFor(distribution, mcVersion) {
  const spec = distributions.list().find((d) => d.id === distribution);
  if (!spec) throw new Error(`Unknown distribution ${distribution}`);
  if (spec.kind === 'proxy') return PROXY_JAVA;
  // Versions before 1.17 have no javaVersion entry; they run on Java 8.
  if (!known.has(mcVersion)) known.set(mcVersion, (await distributions.resolve('vanilla', mcVersion)).javaMajor ?? 8);
  return known.get(mcVersion);
}

// { major, release, url, algo, hash, size, file } for the newest JRE of `major`.
async function resolveRuntime(major, arch = process.arch) {
  if (!Number.isInteger(major) || major < 8 || major > 99) throw new Error(`Invalid Java version ${major}`);
  if (!ARCH[arch]) throw new Error(`No Java runtime for the ${arch} architecture`);
  const url = `${API}/assets/latest/${major}/hotspot?architecture=${ARCH[arch]}&image_type=jre&os=linux&vendor=eclipse`;
  const res = await distributions.fetchRetry(url, { headers: { 'User-Agent': distributions.USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Adoptium API ${res.status} for Java ${major}`);
  const [asset] = await res.json();
  const pkg = asset?.binary?.package;
  if (!pkg?.link || !/^[a-f0-9]{64}$/.test(pkg.checksum || '')) throw new Error(`Java ${major} has no verifiable download`);
  const mirror = new URL(API);
  const link = new URL(pkg.link);
  const fromMirror = !/(^|\.)adoptium\.net$/.test(mirror.hostname) && link.protocol === mirror.protocol && link.host === mirror.host;
  if (!DOWNLOAD_RE.test(link.href) && !fromMirror) throw new Error(`Unexpected download host ${link.hostname}`);
  return { major, release: asset.release_name || null, url: link.href, algo: 'sha256', hash: pkg.checksum, size: pkg.size ?? null, file: distributions.safeFile(pkg.name, `jre-${major}.tar.gz`) };
}

module.exports = { majorFor, resolveRuntime };

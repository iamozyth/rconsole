'use strict';

// Helper tasks for the servers rconsole installs itself (SERVERS_DIR, see
// lib/instances.js). Part of the privileged helper (bin/mc-helper.js): runs
// as the Minecraft user in rconsole-net@ (downloads) or rconsole-job@.
//
// What rconsole sends is a wish (distribution, version, memory, port…); the
// download, its checksum, the Java version and the launch target are all
// worked out here again from the publishers' APIs.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('../lib/config');
const distributions = require('../lib/distributions');
const java = require('../lib/java');
const instances = require('../lib/instances');
const properties = require('../lib/properties');
const names = require('../lib/names');
const velocity = require('../lib/velocity');
const modpack = require('../lib/modpack');
const modrinth = require('../lib/modrinth');
const archive = require('../lib/archive');

const SV = config.serversDir;
const javaRoot = () => path.join(SV, '.java');
const RCON_PORTS = [25575, 25675];
const MOJANG_PROFILES = process.env.MOJANG_PROFILES || 'https://api.mojang.com/users/profiles/minecraft';

const fail = (msg) => {
  throw new Error(msg);
};

// Our own timer instead of spawn's timeout option: that one stays armed
// when the program can't be started at all, keeping the process alive
// for the whole timeout.
function run(cmd, args, { cwd, capture = false, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(signal === 'SIGKILL' ? `${path.basename(cmd)} took longer than ${Math.round(timeoutMs / 60000)} minutes` : err.trim().split('\n').pop() || `${path.basename(cmd)} exited with ${code}`));
    });
  });
}

async function download({ url, algo, hash }) {
  const res = await distributions.fetchRetry(url, { headers: { 'User-Agent': distributions.USER_AGENT }, redirect: 'follow' });
  if (!res.ok) fail(`Download failed: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const actual = crypto.createHash(algo).update(body).digest('hex');
  if (actual !== hash) fail(`Checksum mismatch for ${url.split('/').pop()} (expected ${hash}, got ${actual})`);
  return body;
}

const tmpName = (base) => `${base}.${crypto.randomBytes(6).toString('hex')}.tmp`;

function serversRoot() {
  const st = fs.lstatSync(SV, { throwIfNoEntry: false });
  if (!st?.isDirectory()) fail(`${SV} doesn't exist (see README: servers folder)`);
  return SV;
}

// --- Java ----------------------------------------------------------------------

// Names in a JRE archive: one top folder, no absolute or ".." paths. Listed
// with plain -t so GNU tar (Debian) and bsdtar read it the same way; the
// file types are checked after extraction (checkTree).
async function inspectJre(file) {
  const names = (await run('tar', ['-tzf', file], { capture: true })).split('\n').filter(Boolean);
  let top = null;
  for (const raw of names) {
    const name = raw.replace(/\/$/, '');
    if (name.startsWith('/') || name.split('/').includes('..')) fail('The Java archive contains unsafe paths');
    const root = name.split('/')[0];
    if (top === null) top = root;
    if (root !== top) fail('The Java archive must have one top folder');
  }
  if (!top) fail('The Java archive is empty');
  return top;
}

// Only plain files and folders may come out of the archive (the links
// Temurin ships under legal/ are excluded from extraction).
function checkTree(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) checkTree(p);
    else if (!e.isFile() || fs.lstatSync(p).nlink > 1) fail(`The Java archive contains a link or special file: ${path.basename(p)}`);
  }
}

async function javaInstall({ major }) {
  if (!Number.isInteger(major)) fail('Invalid Java version');
  serversRoot();
  const dest = path.join(javaRoot(), String(major));
  if (fs.existsSync(path.join(dest, 'bin', 'java'))) return { major, installed: false };
  const rt = await java.resolveRuntime(major);
  const body = await download(rt);
  fs.mkdirSync(javaRoot(), { recursive: true, mode: 0o750 });
  const archive = path.join(javaRoot(), tmpName('jre.tar.gz'));
  const staging = path.join(javaRoot(), tmpName(`.${major}`));
  fs.writeFileSync(archive, body, { mode: 0o600, flag: 'wx' });
  try {
    const top = await inspectJre(archive);
    fs.mkdirSync(staging, { mode: 0o750 });
    await run('tar', ['-xzf', archive, '-C', staging, '--no-same-owner', '--exclude', `${top}/legal`, '--strip-components=1', '--', top]);
    checkTree(staging);
    if (!fs.statSync(path.join(staging, 'bin', 'java')).isFile()) fail('The Java archive has no bin/java');
    fs.renameSync(staging, dest);
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { major, installed: true, release: rt.release };
}

// --- create --------------------------------------------------------------------

// Game ports already taken: the other installed servers' and that of a
// server rconsole attaches to in MC_DIR.
function usedGamePorts() {
  const used = new Set(instances.list(SV).map((i) => i.port));
  try {
    const p = properties.toObject(properties.parse(fs.readFileSync(path.join(config.mcDir, 'server.properties'), 'utf8')));
    used.add(Number(p['server-port']) || 25565);
  } catch {}
  return used;
}

// Velocity binds 0.0.0.0:25565 unless told otherwise; its own default
// config, with the chosen port, modern forwarding and none of the example
// servers, becomes velocity.toml. The forwarding secret is ours, so servers
// created behind the proxy can use it before its first start.
function writeVelocityConfig(dir, jarFile, port) {
  const defaults = require('../lib/zip').readFileEntry(path.join(dir, jarFile), 'default-velocity.toml');
  if (!defaults) fail('The Velocity jar has no default configuration');
  fs.writeFileSync(path.join(dir, 'velocity.toml'), velocity.configure(defaults.toString('utf8'), port), { mode: 0o640, flag: 'wx' });
  fs.writeFileSync(path.join(dir, 'forwarding.secret'), crypto.randomBytes(24).toString('base64url'), { mode: 0o640, flag: 'wx' });
}

// RCON ports in use: from instance.json, or from server.properties for
// servers made before 4.3 (which kept it only there). The server can edit
// that file, so only a port in the range rconsole hands out counts: it ends
// up in the port lock and the firewall.
function rconPortOf(i) {
  if (i.rconPort) return i.rconPort;
  try {
    const port = Number(properties.toObject(properties.parse(fs.readFileSync(path.join(SV, i.id, 'server.properties'), 'utf8')))['rcon.port']);
    return Number.isInteger(port) && port >= RCON_PORTS[0] && port <= RCON_PORTS[1] ? port : null;
  } catch {
    return null;
  }
}

function usedRconPorts() {
  return new Set(instances.list(SV).map(rconPortOf).filter(Boolean));
}

// Never a port another server plays on (a proxy defaults to 25577).
function freeRconPort(gamePort) {
  const used = new Set([...usedRconPorts(), ...usedGamePorts(), gamePort]);
  for (let p = RCON_PORTS[0]; p <= RCON_PORTS[1]; p++) if (!used.has(p) && p !== config.rconPort) return p;
  fail('No free RCON port');
}

// Where the server ends up once the jar is in place or the installer ran.
function findLaunch(dir, resolved) {
  const exists = (p) => fs.existsSync(path.join(dir, p));
  switch (resolved.distribution) {
    case 'fabric':
      return exists('fabric-server-launch.jar') ? { type: 'jar', path: 'fabric-server-launch.jar' } : null;
    case 'quilt':
      return exists('quilt-server-launch.jar') ? { type: 'jar', path: 'quilt-server-launch.jar' } : null;
    case 'forge': {
      const p = `libraries/net/minecraftforge/forge/${resolved.version}-${resolved.build}/unix_args.txt`;
      return exists(p) ? { type: 'argsfile', path: p } : null;
    }
    case 'neoforge': {
      const p = `libraries/net/neoforged/neoforge/${resolved.build}/unix_args.txt`;
      return exists(p) ? { type: 'argsfile', path: p } : null;
    }
    default:
      return exists(resolved.file) ? { type: 'jar', path: resolved.file } : null;
  }
}

// Recommended for a new server: closed until players are whitelisted, no
// player addresses in the log, and a simulation distance that keeps the
// tick fast while players still see as far (vanilla simulates 10 chunks).
// Chunk writes go to Paper's and Minecraft's own IO threads.
const RECOMMENDED = {
  'white-list': 'true',
  'enforce-whitelist': 'true',
  'enforce-secure-profile': 'true',
  'log-ips': 'false',
  'view-distance': '10',
  'simulation-distance': '6',
  'sync-chunk-writes': 'false',
};
const WHITELIST = { 'white-list': 'true', 'enforce-whitelist': 'true', 'log-ips': 'false' };

function writeServerProperties(dir, { port, rconPort, motd, recommended, proxied, pack = {} }) {
  const doc = properties.set(properties.parse(''), {
    motd: String(motd || 'A Minecraft server').replace(/[\r\n]/g, ' ').slice(0, 59),
    ...(recommended ? RECOMMENDED : {}),
    // A modpack's own settings (view distance, difficulty…) over the
    // recommended ones, except the whitelist; rconsole's port and RCON win.
    ...pack,
    ...(recommended ? WHITELIST : {}),
    'server-port': String(port),
    'enable-rcon': 'true',
    'rcon.port': String(rconPort),
    'rcon.password': crypto.randomBytes(24).toString('base64url'),
    // Behind the proxy: reachable from this machine only; the proxy checks
    // accounts and forwards who the player is.
    ...(proxied ? { 'server-ip': '127.0.0.1', 'online-mode': 'false' } : {}),
  });
  fs.writeFileSync(path.join(dir, 'server.properties'), properties.stringify(doc), { mode: 0o640, flag: 'wx' });
}

// Paper 1.19+ reads config/*.yml and fills in everything left out. Anti-xray
// hides ores from x-ray clients at little cost; optimized explosions are the
// same TNT with far less work.
const PAPER_WORLD_DEFAULTS = `# Written by rconsole when the server was created.
anticheat:
  anti-xray:
    enabled: true
environment:
  optimize-explosions: true
`;

const PAPER_FAMILY = new Set(['paper', 'folia', 'purpur']);
// config/paper-*.yml exists from Minecraft 1.19 (and in every 26.x).
const newConfigs = (version) => {
  const [a, b] = version.split('.').map(Number);
  return a > 1 || b >= 19;
};

// The secret of proxy `id`, which must be a Velocity proxy rconsole runs.
function proxySecret(id) {
  const proxy = instances.read(SV, id);
  if (proxy.kind !== 'proxy') fail(`${id} is not a proxy`);
  const file = path.join(SV, id, 'forwarding.secret');
  const st = noLinks(file);
  if (!st?.isFile() || st.size > 256) fail(`${id} has no forwarding.secret yet; start the proxy once`);
  return fs.readFileSync(file, 'utf8').trim();
}

// Adds (or with port null, removes) a server in the proxy's velocity.toml.
function registerWithProxy(proxyId, id, port) {
  const file = path.join(SV, proxyId, 'velocity.toml');
  const st = noLinks(file);
  if (!st?.isFile()) fail(`${proxyId} has no velocity.toml`);
  const toml = fs.readFileSync(file, 'utf8');
  const next = port ? velocity.addServer(toml, id, port) : velocity.removeServer(toml, id);
  const tmp = path.join(SV, proxyId, tmpName('.velocity.toml'));
  fs.writeFileSync(tmp, next, { mode: 0o640, flag: 'wx' });
  fs.renameSync(tmp, file);
}

// Puts `name` on the new server's whitelist, so the admin can join. The
// UUID comes from Mojang; without it the whitelist stays empty (rconsole's
// Players page adds people later).
async function whitelistOwner(dir, name) {
  if (!/^[A-Za-z0-9_]{3,16}$/.test(String(name || ''))) return null;
  try {
    const res = await distributions.fetchRetry(`${MOJANG_PROFILES}/${name}`, { headers: { 'User-Agent': distributions.USER_AGENT, Accept: 'application/json' } });
    if (!res.ok) return null;
    const { id, name: exact } = await res.json();
    if (!/^[0-9a-f]{32}$/.test(String(id)) || !/^[A-Za-z0-9_]{3,16}$/.test(String(exact))) return null;
    const uuid = id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    fs.writeFileSync(path.join(dir, 'whitelist.json'), `${JSON.stringify([{ uuid, name: exact }], null, 2)}\n`, { mode: 0o640, flag: 'wx' });
    return exact;
  } catch {
    return null;
  }
}

// --- modpacks ----------------------------------------------------------------------

const PACK_RESERVE = 2 * 1024 ** 3; // left free for the server and its logs
const PACK_CONCURRENCY = 6;

function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return Infinity; // Node < 18.15: the extractor's own checks still apply
  }
}

// Downloads the .mrpack of Modrinth version `versionId`, checks it and
// unpacks it into a folder of its own. The caller removes `dir`.
async function fetchPack(versionId, dir) {
  if (!modrinth.ID_RE.test(String(versionId))) fail('Invalid modpack version');
  const v = await modrinth.version(versionId);
  if (v.id !== versionId) fail('Modrinth answered with another version');
  const file = modpack.packFile(v, process.env.MODRINTH_API || 'https://api.modrinth.com/v2');
  const body = await download({ url: file.url, algo: 'sha512', hash: file.sha512 });
  fs.mkdirSync(dir, { mode: 0o750 });
  const zip = path.join(dir, 'pack.mrpack');
  fs.writeFileSync(zip, body, { mode: 0o600, flag: 'wx' });
  const out = path.join(dir, 'pack');
  fs.mkdirSync(out, { mode: 0o750 });
  const fd = fs.openSync(zip, 'r');
  try {
    if (archive.detect(Buffer.from(body.subarray(0, 512))) !== 'zip') fail('The modpack is not a zip file');
    await archive.extract(fd, out, { maxBytes: Math.max(0, freeBytes(SV) - PACK_RESERVE) });
  } catch (err) {
    fail(`Can't unpack the modpack: ${err.message}`);
  } finally {
    fs.closeSync(fd);
  }
  const indexFile = path.join(out, 'modrinth.index.json');
  if (!fs.lstatSync(indexFile, { throwIfNoEntry: false })?.isFile()) fail('The modpack has no modrinth.index.json');
  const index = modpack.parseIndex(fs.readFileSync(indexFile, 'utf8'));
  if (index.bytes > freeBytes(SV) - PACK_RESERVE) fail(`The modpack needs ${(index.bytes / 1024 ** 3).toFixed(1)} GB, more than the free disk space allows`);
  return { ...index, projectId: modrinth.ID_RE.test(String(v.project_id)) ? v.project_id : null, versionId, root: out };
}

// Copies a folder of the unpacked pack over the server folder. Only plain
// files and folders exist there (the extractor makes nothing else); each
// path is checked as the index's are. server.properties is returned instead
// of copied, for merging.
function overlay(from, dir, props) {
  if (!fs.lstatSync(from, { throwIfNoEntry: false })?.isDirectory()) return;
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === 'server.properties' && e.isFile()) {
        Object.assign(props, properties.toObject(properties.parse(fs.readFileSync(path.join(from, r), 'utf8'))));
        continue;
      }
      const parts = modpack.safePath(r);
      const dest = path.join(dir, ...parts);
      if (e.isDirectory()) {
        const st = noLinks(dest);
        if (st && !st.isDirectory()) fail(`The modpack has both a file and a folder named ${r}`);
        if (!st) fs.mkdirSync(dest, { mode: 0o750 });
        walk(r);
      } else if (e.isFile()) {
        const st = noLinks(dest);
        if (st?.isDirectory()) fail(`The modpack has both a file and a folder named ${r}`);
        fs.copyFileSync(path.join(from, r), dest);
        fs.chmodSync(dest, 0o640);
      }
    }
  };
  walk('');
}

// Downloads the pack's files into the server folder (a few at a time, each
// checked against its sha512), then copies overrides/ and
// server-overrides/ over it. Returns the pack's server.properties settings.
async function installPack(dir, pack) {
  const queue = [...pack.files];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const body = await download({ url: f.url, algo: 'sha512', hash: f.sha512 });
      let p = dir;
      for (const part of f.parts.slice(0, -1)) {
        p = path.join(p, part);
        const st = noLinks(p);
        if (st && !st.isDirectory()) fail(`The modpack has both a file and a folder named ${f.path}`);
        if (!st) fs.mkdirSync(p, { mode: 0o750 });
      }
      fs.writeFileSync(path.join(dir, ...f.parts), body, { mode: 0o640, flag: 'wx' });
    }
  };
  // The first failure ends the other workers after their current file.
  await Promise.all(Array.from({ length: PACK_CONCURRENCY }, () => worker().catch((err) => {
    queue.length = 0;
    throw err;
  })));
  const props = {};
  overlay(path.join(pack.root, 'overrides'), dir, props);
  overlay(path.join(pack.root, 'server-overrides'), dir, props);
  return modpack.mergeProperties(props);
}

// Creates SERVERS_DIR/<id> and installs the server in it. On any failure
// the half-made folder is removed again.
async function serverCreate(args) {
  serversRoot();
  const wish = instances.validate({ ...args, java: 8, launch: null, build: args.build ?? null, rconPort: null });
  const eula = args.eula?.by ? { by: String(args.eula.by).replace(/[^\w.@-]/g, '').slice(0, 64), at: String(args.eula.at || '').replace(/[^\w:.+-]/g, '').slice(0, 40) || new Date().toISOString() } : null;
  // Only game servers come under the Minecraft EULA; proxies don't.
  if (wish.kind === 'server' && !eula?.by) fail('The Minecraft EULA must be accepted first');
  const dir = path.join(SV, wish.id);
  if (fs.existsSync(dir)) fail(`A server named ${wish.id} already exists`);
  if (usedGamePorts().has(wish.port)) fail(`Port ${wish.port} is used by another server`);
  if (usedRconPorts().has(wish.port) || wish.port === config.rconPort) fail(`Port ${wish.port} is another server's RCON port`);
  if (wish.proxy) {
    if (wish.kind !== 'server' || !PAPER_FAMILY.has(wish.distribution)) fail('Only Paper, Folia and Purpur servers can join a proxy here (Fabric and Forge need a forwarding mod)');
    if (!newConfigs(wish.version)) fail('Servers behind the proxy need Minecraft 1.19 or newer');
    proxySecret(wish.proxy);
  }
  const recommended = args.recommended !== false;

  // A modpack decides the distribution, Minecraft and loader version; the
  // wish must agree with it (rconsole showed them from Modrinth).
  const packDir = path.join(SV, tmpName(`.${wish.id}-pack`));
  const staging = path.join(SV, tmpName(`.${wish.id}`));
  try {
    let pack = null;
    if (args.modpack) {
      if (wish.kind !== 'server' || wish.proxy) fail('A modpack server can\'t be a proxy or join one');
      pack = await fetchPack(args.modpack.versionId, packDir);
      if (pack.distribution !== wish.distribution || pack.mc !== wish.version) fail(`The modpack needs ${pack.distribution} for Minecraft ${pack.mc}, not ${wish.distribution} ${wish.version}`);
      wish.build = pack.loaderVersion;
    }
    const resolved = await distributions.resolve(wish.distribution, wish.version, wish.build);
    const major = await java.majorFor(wish.distribution, wish.version);
    await javaInstall({ major });

    fs.mkdirSync(staging, { mode: 0o750 });
    const body = await download(resolved);
    fs.writeFileSync(path.join(staging, resolved.file), body, { mode: 0o640, flag: 'wx' });
    if (resolved.install === 'installer') {
      await run(path.join(javaRoot(), String(major), 'bin', 'java'), ['-jar', resolved.file, ...resolved.installArgs], { cwd: staging, timeoutMs: 14 * 60 * 1000 });
      fs.rmSync(path.join(staging, resolved.file), { force: true });
      fs.rmSync(path.join(staging, `${resolved.file}.log`), { force: true });
    }
    const launch = findLaunch(staging, resolved);
    if (!launch) fail(`The ${resolved.distribution} installer finished, but no server to start was found`);
    const packProps = pack ? await installPack(staging, pack) : {};
    let rconPort = null;
    let whitelisted = null;
    if (wish.kind === 'proxy') writeVelocityConfig(staging, launch.path, wish.port);
    if (wish.kind === 'server') {
      rconPort = freeRconPort(wish.port);
      writeServerProperties(staging, { port: wish.port, rconPort, motd: pack?.name || wish.name, recommended, proxied: Boolean(wish.proxy), pack: packProps });
      fs.writeFileSync(path.join(staging, 'eula.txt'), `# Accepted in rconsole by ${eula.by} on ${eula.at}: https://aka.ms/MinecraftEULA\neula=true\n`, { mode: 0o640 });
      const paperConfigs = PAPER_FAMILY.has(wish.distribution) && newConfigs(resolved.version);
      if (paperConfigs && (recommended || wish.proxy)) fs.mkdirSync(path.join(staging, 'config'), { mode: 0o750 });
      if (paperConfigs && recommended) fs.writeFileSync(path.join(staging, 'config', 'paper-world-defaults.yml'), PAPER_WORLD_DEFAULTS, { mode: 0o640, flag: 'wx' });
      if (wish.proxy) fs.writeFileSync(path.join(staging, 'config', 'paper-global.yml'), velocity.paperGlobal(proxySecret(wish.proxy)), { mode: 0o640, flag: 'wx' });
      if (recommended) whitelisted = await whitelistOwner(staging, args.owner);
    }
    const instance = instances.validate({
      ...wish, build: resolved.build, java: major, launch, created: new Date().toISOString(),
      eula, rconPort,
      modpack: pack && { projectId: pack.projectId, versionId: pack.versionId, name: pack.name, version: pack.version, files: pack.files.length },
    });
    fs.writeFileSync(path.join(staging, 'instance.json'), `${JSON.stringify(instance, null, 2)}\n`, { mode: 0o640, flag: 'wx' });
    fs.renameSync(staging, dir);
    if (wish.proxy) registerWithProxy(wish.proxy, wish.id, wish.port);
    return { id: wish.id, distribution: resolved.distribution, version: resolved.version, build: resolved.build, java: major, verified: resolved.algo, whitelisted, proxy: wish.proxy, modpack: pack && { name: pack.name, version: pack.version, files: pack.files.length, clientOnly: pack.clientOnly } };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(packDir, { recursive: true, force: true });
  }
}

// --- update and rollback ----------------------------------------------------------

function writeInstance(dir, instance) {
  const file = path.join(dir, 'instance.json');
  const tmp = path.join(dir, tmpName('.instance.json'));
  fs.writeFileSync(tmp, `${JSON.stringify(instances.validate(instance), null, 2)}\n`, { mode: 0o640, flag: 'wx' });
  fs.renameSync(tmp, file);
}

// Jars no longer named by the current or previous install go, so updates
// don't pile up. Only plain files at the top of the folder are touched.
function pruneJars(dir, keep) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && /\.jar$/.test(e.name) && !keep.has(e.name) && !/-launch\.jar$|^server\.jar$/.test(e.name)) fs.rmSync(path.join(dir, e.name));
  }
}

// Mod loader installers (Fabric, Quilt, Forge, NeoForge) write into the
// server folder in place: the top-level jars and scripts and libraries/.
// Those are copied aside before an update, put back if it fails, and are
// what Roll back restores.
const SNAPSHOT = '.rconsole-previous';
const snapshotItems = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .filter((e) => (e.isFile() && /\.(jar|sh|bat)$|^user_jvm_args\.txt$/.test(e.name)) || (e.isDirectory() && e.name === 'libraries'))
  .map((e) => e.name);

// Copies the files an installer touches into <dir>/<to>. A copy that fails
// halfway is removed again and the live files are left alone.
async function snapshot(dir, to) {
  const snap = path.join(dir, to);
  noLinks(snap);
  fs.rmSync(snap, { recursive: true, force: true });
  fs.mkdirSync(snap, { mode: 0o750 });
  try {
    for (const name of snapshotItems(dir)) await run('cp', ['-a', '--', path.join(dir, name), path.join(snap, name)]);
  } catch (err) {
    fs.rmSync(snap, { recursive: true, force: true });
    throw err;
  }
}

// The server writes its own folder (and instance.json), so a plugin could
// plant links there; this job may write all of SERVERS_DIR. Nothing it
// moves, copies or lets an installer write may be a link.
function noLinks(p) {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) fail(`${path.basename(p)} is a link; refusing to touch it`);
  return st;
}

function noLinksBelow(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) fail(`${path.relative(SV, p)} is a link; refusing to update in place`);
    if (e.isDirectory()) noLinksBelow(p);
  }
}

async function restoreSnapshot(dir, from = SNAPSHOT) {
  const snap = path.join(dir, from);
  const st = noLinks(snap);
  if (!st?.isDirectory()) fail('Nothing to roll back to');
  for (const name of fs.readdirSync(snap)) {
    const e = fs.lstatSync(path.join(snap, name));
    if (!e.isFile() && !e.isDirectory()) fail(`${from}/${name} is a link or special file`);
  }
  for (const name of snapshotItems(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  for (const name of fs.readdirSync(snap)) fs.renameSync(path.join(snap, name), path.join(dir, name));
  fs.rmSync(snap, { recursive: true, force: true });
}

// Runs a mod loader installer in an empty folder of its own, then puts what
// it wrote in place of the installer's files in the server folder. The
// installer never runs inside the server folder, where a plugin could have
// planted links that lead it into another server. The admin's
// user_jvm_args.txt stays.
async function installFresh(dir, dl, resolved, major) {
  const staging = path.join(SV, tmpName(`.${path.basename(dir)}-install`));
  fs.mkdirSync(staging, { mode: 0o750 });
  try {
    fs.renameSync(dl, path.join(staging, resolved.file));
    await run(path.join(javaRoot(), String(major), 'bin', 'java'), ['-jar', resolved.file, ...resolved.installArgs], { cwd: staging, timeoutMs: 14 * 60 * 1000 });
    fs.rmSync(path.join(staging, resolved.file), { force: true });
    fs.rmSync(path.join(staging, `${resolved.file}.log`), { force: true });
    noLinksBelow(staging);
    const keepArgs = fs.existsSync(path.join(dir, 'user_jvm_args.txt'));
    for (const name of snapshotItems(dir)) if (!(keepArgs && name === 'user_jvm_args.txt')) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    // Only the kinds of files an installer owns; anything else it wrote
    // (logs) is left behind, so it can never replace worlds or settings.
    for (const name of snapshotItems(staging)) {
      if (keepArgs && name === 'user_jvm_args.txt') continue;
      // rename replaces a link at the destination instead of following it.
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      fs.renameSync(path.join(staging, name), path.join(dir, name));
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// Installs another version or build of the same distribution into an
// existing server (rconsole stops it first), keeping what ran before for
// rollback. With rollback, swaps back to that.
async function serverUpdate({ id, version, build = null, rollback = false }) {
  serversRoot();
  const current = instances.read(SV, id);
  const dir = path.join(SV, id);
  const was = { version: current.version, build: current.build, java: current.java, launch: current.launch };
  if (rollback) {
    const prev = current.previous;
    if (!prev?.launch) fail('Nothing to roll back to');
    // Installer distributions: the files come back from the snapshot, once.
    if (prev.snapshot) {
      await restoreSnapshot(dir);
      writeInstance(dir, { ...current, ...prev, snapshot: undefined, previous: null });
      return { id, rolledBack: true, version: prev.version, build: prev.build };
    }
    if (!fs.existsSync(path.join(dir, prev.launch.path))) fail(`${prev.launch.path} is gone; can't roll back`);
    writeInstance(dir, { ...current, ...prev, previous: was });
    return { id, rolledBack: true, version: prev.version, build: prev.build };
  }
  const resolved = await distributions.resolve(current.distribution, version, build);
  if (resolved.version === current.version && resolved.build === current.build) fail(`${id} already runs ${version}${build ? ` #${build}` : ''}`);
  const major = await java.majorFor(current.distribution, resolved.version);
  await javaInstall({ major });
  const body = await download(resolved);
  const dl = path.join(dir, tmpName(`.${resolved.file}`));
  fs.writeFileSync(dl, body, { mode: 0o640, flag: 'wx' });
  // In-place installs snapshot the current files to .rconsole-next first: a
  // failed install comes back from it, and only a successful one replaces
  // the snapshot Roll back uses.
  const inPlace = resolved.install === 'installer';
  const NEXT = `${SNAPSHOT}-next`;
  if (inPlace) {
    // The snapshot copies libraries/, scripts and jars; none may be a link.
    for (const name of ['libraries', 'run.sh', 'run.bat', 'user_jvm_args.txt', SNAPSHOT]) noLinks(path.join(dir, name));
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isSymbolicLink() && /\.jar$/.test(e.name)) fail(`${e.name} is a link; refusing to update in place`);
    if (fs.existsSync(path.join(dir, 'libraries'))) noLinksBelow(path.join(dir, 'libraries'));
    await snapshot(dir, NEXT);
  }
  let launch;
  try {
    if (inPlace) {
      await installFresh(dir, dl, resolved, major);
    } else {
      fs.renameSync(dl, path.join(dir, resolved.file));
    }
    launch = findLaunch(dir, resolved);
    if (!launch) fail(`The ${resolved.distribution} update finished, but no server to start was found`);
  } catch (err) {
    if (inPlace) await restoreSnapshot(dir, NEXT).catch(() => {});
    throw err;
  } finally {
    fs.rmSync(dl, { force: true });
  }
  if (inPlace) {
    fs.rmSync(path.join(dir, SNAPSHOT), { recursive: true, force: true });
    fs.renameSync(path.join(dir, NEXT), path.join(dir, SNAPSHOT));
  }
  writeInstance(dir, { ...current, version: resolved.version, build: resolved.build, java: major, launch, previous: { ...was, snapshot: inPlace } });
  pruneJars(dir, new Set([launch.path, was.launch?.path].filter((p) => p && !p.includes('/'))));
  return { id, version: resolved.version, build: resolved.build, java: major, verified: resolved.algo };
}

// --- settings ------------------------------------------------------------------

// Memory, JVM flags, autostart and the port lock of an existing server; they
// apply at its next start. rconsole checks the memory against the machine.
async function serverConfigure({ id, ...changes }) {
  serversRoot();
  const current = instances.read(SV, id);
  const allowed = ['memoryMb', 'flags', 'autostart', 'portLock', 'extraPorts'];
  const next = { ...current };
  for (const k of allowed) if (Object.hasOwn(changes, k)) next[k] = changes[k];
  // Pre-4.3 servers learn their RCON port here.
  next.rconPort = rconPortOf(current);
  writeInstance(path.join(SV, id), next);
  return { id, ...Object.fromEntries(allowed.map((k) => [k, instances.validate(next)[k]])) };
}

// --- delete --------------------------------------------------------------------

// Archives SERVERS_DIR/<id> into BACKUP_DIR (unless archive is false), then
// removes it. rconsole stops the server first.
async function serverDelete({ id, archive = true }) {
  serversRoot();
  const doomed = instances.read(SV, id);
  // Best effort: the proxy may be gone or its config edited by hand.
  if (doomed.proxy) {
    try {
      registerWithProxy(doomed.proxy, id, null);
    } catch {}
  }
  let archived = null;
  if (archive) {
    // Not next to the world backups, so it never shows up as one of them.
    const into = path.join(config.backupDir, 'deleted-servers');
    fs.mkdirSync(into, { recursive: true, mode: 0o750 });
    if (!fs.lstatSync(into).isDirectory()) fail(`${into} is not a folder`);
    archived = `deleted-servers/${id}-${names.timestamp()}.tar.gz`;
    const partial = path.join(into, tmpName(path.basename(archived)));
    const fd = fs.openSync(partial, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o640);
    try {
      await new Promise((resolve, reject) => {
        const child = spawn('tar', ['-czf', '-', '-C', SV, '--', id], { stdio: ['ignore', fd, 'pipe'] });
        let err = '';
        child.stderr.on('data', (d) => (err += d));
        child.on('error', reject);
        child.on('close', (code) => (code <= 1 ? resolve() : reject(new Error(err.trim() || `tar exited with ${code}`))));
      });
      fs.closeSync(fd);
      fs.renameSync(partial, path.join(config.backupDir, archived));
    } catch (err) {
      try { fs.closeSync(fd); } catch {}
      fs.rmSync(partial, { force: true });
      throw err;
    }
  }
  // Park first so a half-deleted folder never looks like a server.
  const parked = path.join(SV, tmpName(`.deleted-${id}`));
  fs.renameSync(path.join(SV, id), parked);
  fs.rmSync(parked, { recursive: true, force: true });
  return { deleted: id, archived };
}

module.exports = {
  TASKS: { 'java-install': javaInstall, 'server-create': serverCreate, 'server-update': serverUpdate, 'server-delete': serverDelete, 'server-configure': serverConfigure },
  inspectJre,
  writeVelocityConfig,
  checkTree,
  findLaunch,
  javaInstall,
  download,
  run,
};

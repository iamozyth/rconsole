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

const SV = config.serversDir;
const javaRoot = () => path.join(SV, '.java');
const RCON_PORTS = [25575, 25675];

const fail = (msg) => {
  throw new Error(msg);
};

function run(cmd, args, { cwd, capture = false, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'], timeout: timeoutMs });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `${path.basename(cmd)} exited with ${code}`))));
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
// config, with the chosen port, becomes velocity.toml.
function writeVelocityConfig(dir, jarFile, port) {
  const defaults = require('../lib/zip').readFileEntry(path.join(dir, jarFile), 'default-velocity.toml');
  if (!defaults) fail('The Velocity jar has no default configuration');
  const toml = defaults.toString('utf8').replace(/^bind = ".*"$/m, `bind = "0.0.0.0:${port}"`);
  if (!toml.includes(`bind = "0.0.0.0:${port}"`)) fail('Could not set the Velocity port');
  fs.writeFileSync(path.join(dir, 'velocity.toml'), toml, { mode: 0o640, flag: 'wx' });
}

function usedRconPorts() {
  const used = new Set();
  for (const i of instances.list(SV)) {
    try {
      const p = properties.parse(fs.readFileSync(path.join(SV, i.id, 'server.properties'), 'utf8'));
      const port = Number(properties.toObject(p)['rcon.port']);
      if (Number.isInteger(port)) used.add(port);
    } catch {}
  }
  return used;
}

function freeRconPort() {
  const used = usedRconPorts();
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

function writeServerProperties(dir, { port, motd }) {
  const doc = properties.set(properties.parse(''), {
    'server-port': String(port),
    'enable-rcon': 'true',
    'rcon.port': String(freeRconPort()),
    'rcon.password': crypto.randomBytes(24).toString('base64url'),
    motd: String(motd || 'A Minecraft server').replace(/[\r\n]/g, ' ').slice(0, 59),
  });
  fs.writeFileSync(path.join(dir, 'server.properties'), properties.stringify(doc), { mode: 0o640, flag: 'wx' });
}

// Creates SERVERS_DIR/<id> and installs the server in it. On any failure
// the half-made folder is removed again.
async function serverCreate(args) {
  serversRoot();
  const wish = instances.validate({ ...args, java: 8, launch: null, build: args.build ?? null });
  const eula = args.eula?.by ? { by: String(args.eula.by).replace(/[^\w.@-]/g, '').slice(0, 64), at: String(args.eula.at || '').replace(/[^\w:.+-]/g, '').slice(0, 40) || new Date().toISOString() } : null;
  // Only game servers come under the Minecraft EULA; proxies don't.
  if (wish.kind === 'server' && !eula?.by) fail('The Minecraft EULA must be accepted first');
  const dir = path.join(SV, wish.id);
  if (fs.existsSync(dir)) fail(`A server named ${wish.id} already exists`);
  if (usedGamePorts().has(wish.port)) fail(`Port ${wish.port} is used by another server`);

  const resolved = await distributions.resolve(wish.distribution, wish.version, wish.build);
  const major = await java.majorFor(wish.distribution, wish.version);
  await javaInstall({ major });

  const staging = path.join(SV, tmpName(`.${wish.id}`));
  fs.mkdirSync(staging, { mode: 0o750 });
  try {
    const body = await download(resolved);
    fs.writeFileSync(path.join(staging, resolved.file), body, { mode: 0o640, flag: 'wx' });
    if (resolved.install === 'installer') {
      await run(path.join(javaRoot(), String(major), 'bin', 'java'), ['-jar', resolved.file, ...resolved.installArgs], { cwd: staging, timeoutMs: 14 * 60 * 1000 });
      fs.rmSync(path.join(staging, resolved.file), { force: true });
      fs.rmSync(path.join(staging, `${resolved.file}.log`), { force: true });
    }
    const launch = findLaunch(staging, resolved);
    if (!launch) fail(`The ${resolved.distribution} installer finished, but no server to start was found`);
    if (wish.kind === 'proxy') writeVelocityConfig(staging, launch.path, wish.port);
    if (wish.kind === 'server') {
      writeServerProperties(staging, { port: wish.port, motd: wish.name });
      fs.writeFileSync(path.join(staging, 'eula.txt'), `# Accepted in rconsole by ${eula.by} on ${eula.at}: https://aka.ms/MinecraftEULA\neula=true\n`, { mode: 0o640 });
    }
    const instance = instances.validate({
      ...wish, build: resolved.build, java: major, launch, created: new Date().toISOString(),
      eula,
    });
    fs.writeFileSync(path.join(staging, 'instance.json'), `${JSON.stringify(instance, null, 2)}\n`, { mode: 0o640, flag: 'wx' });
    fs.renameSync(staging, dir);
    return { id: wish.id, distribution: resolved.distribution, version: resolved.version, build: resolved.build, java: major, verified: resolved.algo };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
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
  fs.rmSync(snap, { recursive: true, force: true });
  fs.mkdirSync(snap, { mode: 0o750 });
  try {
    for (const name of snapshotItems(dir)) await run('cp', ['-a', '--', path.join(dir, name), path.join(snap, name)]);
  } catch (err) {
    fs.rmSync(snap, { recursive: true, force: true });
    throw err;
  }
}

async function restoreSnapshot(dir, from = SNAPSHOT) {
  const snap = path.join(dir, from);
  if (!fs.existsSync(snap)) fail('Nothing to roll back to');
  for (const name of snapshotItems(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  for (const name of fs.readdirSync(snap)) fs.renameSync(path.join(snap, name), path.join(dir, name));
  fs.rmSync(snap, { recursive: true, force: true });
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
  if (inPlace) await snapshot(dir, NEXT);
  let launch;
  try {
    if (inPlace) {
      fs.renameSync(dl, path.join(dir, resolved.file));
      try {
        await run(path.join(javaRoot(), String(major), 'bin', 'java'), ['-jar', resolved.file, ...resolved.installArgs], { cwd: dir, timeoutMs: 14 * 60 * 1000 });
      } finally {
        fs.rmSync(path.join(dir, resolved.file), { force: true });
        fs.rmSync(path.join(dir, `${resolved.file}.log`), { force: true });
      }
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

// --- delete --------------------------------------------------------------------

// Archives SERVERS_DIR/<id> into BACKUP_DIR (unless archive is false), then
// removes it. rconsole stops the server first.
async function serverDelete({ id, archive = true }) {
  serversRoot();
  instances.read(SV, id);
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
  TASKS: { 'java-install': javaInstall, 'server-create': serverCreate, 'server-update': serverUpdate, 'server-delete': serverDelete },
  inspectJre,
  writeVelocityConfig,
  checkTree,
  findLaunch,
};

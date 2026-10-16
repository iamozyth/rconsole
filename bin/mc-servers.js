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
  const res = await fetch(url, { headers: { 'User-Agent': distributions.USER_AGENT }, redirect: 'follow' });
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

// Lists a JRE archive: one top folder, files and folders only; the links
// Temurin ships under legal/ are left out of the extraction.
async function inspectJre(file) {
  const listing = await run('tar', ['-tvzf', file], { capture: true });
  let top = null;
  for (const line of listing.split('\n').filter(Boolean)) {
    const m = line.match(/^(\S)\S*\s+\S+\s+\d+\s+\S+\s+\S+\s+(.+?)(?: -> .*)?$/);
    if (!m) fail('Unexpected archive listing');
    const name = m[2].replace(/\/$/, '');
    if (name.startsWith('/') || name.split('/').includes('..')) fail('The Java archive contains unsafe paths');
    const [root, second] = name.split('/');
    if (top === null) top = root;
    if (root !== top) fail('The Java archive must have one top folder');
    if (!'-d'.includes(m[1]) && !(m[1] === 'l' && second === 'legal')) fail('The Java archive contains links or special files');
  }
  if (!top) fail('The Java archive is empty');
  return top;
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
    if (!fs.statSync(path.join(staging, 'bin', 'java')).isFile()) fail('The Java archive has no bin/java');
    fs.renameSync(staging, dest);
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { major, installed: true, release: rt.release };
}

// --- create --------------------------------------------------------------------

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
  if (!args.eula?.by) fail('The Minecraft EULA must be accepted first');
  const dir = path.join(SV, wish.id);
  if (fs.existsSync(dir)) fail(`A server named ${wish.id} already exists`);
  if (instances.list(SV).some((i) => i.port === wish.port)) fail(`Port ${wish.port} is used by another server`);

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
    if (wish.kind === 'server') {
      writeServerProperties(staging, { port: wish.port, motd: wish.name });
      fs.writeFileSync(path.join(staging, 'eula.txt'), `# Accepted in rconsole by ${args.eula.by} on ${args.eula.at}: https://aka.ms/MinecraftEULA\neula=true\n`, { mode: 0o640 });
    }
    const instance = instances.validate({
      ...wish, build: resolved.build, java: major, launch, created: new Date().toISOString(),
      eula: { by: String(args.eula.by), at: String(args.eula.at || new Date().toISOString()) },
    });
    fs.writeFileSync(path.join(staging, 'instance.json'), `${JSON.stringify(instance, null, 2)}\n`, { mode: 0o640, flag: 'wx' });
    fs.renameSync(staging, dir);
    return { id: wish.id, distribution: resolved.distribution, version: resolved.version, build: resolved.build, java: major, verified: resolved.algo };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// --- delete --------------------------------------------------------------------

// Archives SERVERS_DIR/<id> into BACKUP_DIR (unless archive is false), then
// removes it. rconsole stops the server first.
async function serverDelete({ id, archive = true }) {
  serversRoot();
  instances.read(SV, id);
  let archived = null;
  if (archive) {
    archived = `server-${id}-${names.timestamp()}.tar.gz`;
    const partial = path.join(config.backupDir, tmpName(archived));
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
  TASKS: { 'java-install': javaInstall, 'server-create': serverCreate, 'server-delete': serverDelete },
  NETWORK: ['java-install', 'server-create'],
  inspectJre,
  findLaunch,
};

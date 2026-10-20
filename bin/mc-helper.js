#!/usr/bin/env node
'use strict';

// Privileged half of rconsole. Runs as the Minecraft user, started by the
// rconsole-job@ (offline) and rconsole-net@ (network) systemd units.
//
//   mc-helper.js job <id>        run BACKUP_DIR/.requests/<id>.json
//   mc-helper.js backup <stamp>  legacy rconsole-backup@ unit
//   mc-helper.js update <spec>   legacy rconsole-update@ unit
//
// rconsole only writes the request; everything in it is validated here again,
// and every path stays inside MC_DIR or BACKUP_DIR. The outcome goes to
// BACKUP_DIR/.jobs/<id>.json.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('../lib/config');
const { readProperties } = require('../lib/access');
const properties = require('../lib/properties');
const settings = require('../lib/settings');
const distributions = require('../lib/distributions');
const names = require('../lib/names');
const modrinth = require('../lib/modrinth');
const { FILE_RE: PLUGIN_FILE_RE } = require('../lib/plugins');
const platform = require('../lib/platform');
const configs = require('../lib/configs');
const servers = require('./mc-servers');
const instances = require('../lib/instances');

// MC_DIR, or the folder of the server a request names (see main()).
let MC = config.mcDir;
const BK = config.backupDir;
const jobsDir = path.join(BK, '.jobs');
let jar = path.join(MC, config.mcJar);

const fail = (msg) => {
  throw new Error(msg);
};

function run(cmd, args, { okCodes = [0], capture = false, outFd = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', outFd ?? (capture ? 'pipe' : 'ignore'), 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => (okCodes.includes(code) ? resolve(stdout) : reject(new Error(stderr.trim() || `${cmd} exited with ${code}`))));
  });
}

const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// BACKUP_DIR is group-writable for rconsole, which is less trusted than this
// helper: it can plant symlinks or swap files there at any time. Everything
// the helper writes there is created exclusively (O_EXCL|O_NOFOLLOW) under a
// random name and renamed into place; everything it reads from there is
// opened once, no-follow, and copied somewhere only the helper can write.
const EXCL = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
const randomName = (base) => `${base}.${require('crypto').randomBytes(6).toString('hex')}.tmp`;

function realDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  if (!fs.lstatSync(dir).isDirectory()) fail(`${dir} is not a directory`);
  return dir;
}

function writeExclusive(file, data, mode = 0o640) {
  const tmp = randomName(file);
  const fd = fs.openSync(tmp, EXCL, mode);
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file); // rename replaces a planted link, never follows it
}

const worldDirs = (world) => names.DIMENSIONS.map((d) => world + d).filter((d) => exists(path.join(MC, d)));

async function activeWorld() {
  return (await readProperties(MC))['level-name'] || 'world';
}

function checkWorld(world) {
  if (!names.isWorldName(world)) fail('Invalid world name');
  return world;
}

// --- backup -----------------------------------------------------------------

async function backup({ world, stamp, compression }) {
  world = checkWorld(world || (await activeWorld()));
  if (!names.STAMP_RE.test(stamp || '')) fail('Invalid backup timestamp');
  const dirs = worldDirs(world);
  if (!dirs.length) fail(`No world folder "${world}" in ${MC}`);

  const zst = useZstd(compression);
  const name = `${world}-${stamp}.tar.${zst ? 'zst' : 'gz'}`;
  const final = path.join(BK, name);
  const partial = randomName(`${final}.partial`);
  const fd = fs.openSync(partial, EXCL, 0o640);
  try {
    // tar writes to our descriptor, so nothing in BACKUP_DIR is opened by
    // path. Exit 1 = "file changed as we read it", fine for region files.
    // zstd on all cores is several times faster than gzip, so autosave is
    // paused for a shorter time.
    await run('tar', [...(zst ? ['-I', 'zstd -T0 -3 -q'] : ['-z']), '-cf', '-', '-C', MC, '--', ...dirs], { okCodes: [0, 1], outFd: fd });
    fs.fchmodSync(fd, 0o640);
    fs.closeSync(fd);
    fs.renameSync(partial, final);
  } catch (err) {
    try { fs.closeSync(fd); } catch {}
    fs.rmSync(partial, { force: true });
    throw err;
  }
  return { file: name, world, size: fs.statSync(final).size, dirs };
}

// zstd when it is installed; gzip keeps .tar.gz. The request's compression
// (Settings → System, auto or gzip) wins over BACKUP_COMPRESSION.
let zstdFound = null;
function useZstd(compression) {
  if (!['auto', 'gzip'].includes(compression)) compression = /^gz(ip)?$/i.test(process.env.BACKUP_COMPRESSION || '') ? 'gzip' : 'auto';
  if (compression === 'gzip') return false;
  zstdFound ??= require('child_process').spawnSync('zstd', ['--version'], { stdio: 'ignore' }).status === 0;
  return zstdFound;
}

// tar's flag for reading an archive, from its name.
const unpackFlag = (file) => (names.parseBackupName(file)?.compression === 'zst' ? '--zstd' : '-z');

// --- restore ----------------------------------------------------------------

// Lists an archive and refuses anything but plain files and directories under
// one world's three dimension folders.
async function inspectArchive(file, flag = '-z') {
  const listing = await run('tar', ['-tv', flag, '-f', file], { capture: true });
  const entries = listing.split('\n').filter(Boolean);
  if (!entries.length) fail('The backup is empty');
  const roots = new Set();
  for (const line of entries) {
    if (!'-d'.includes(line[0])) fail('The backup contains links or special files; refusing to restore it');
    // GNU tar: perms owner/group size date time name
    const m = line.match(/^\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+(.+)$/);
    if (!m) fail('Unexpected archive listing');
    const name = m[1];
    if (name.startsWith('/') || name.split('/').includes('..')) fail('The backup contains unsafe paths');
    roots.add(name.split('/')[0]);
  }
  const bases = new Set([...roots].map((r) => r.replace(/_(nether|the_end)$/, '')));
  if (bases.size !== 1) fail('The backup must contain exactly one world');
  return checkWorld([...bases][0]);
}

// Extracts a backup as world `target`. With `replace`, the existing folders are
// parked first and put back if extraction fails. rconsole stops the server
// before replacing the active world.
async function restore({ file, target, replace }) {
  if (!names.parseBackupName(file)) fail('Invalid backup name');
  checkWorld(target);
  // Private copy: rconsole could otherwise swap the archive between the
  // inspection below and the extraction.
  const archive = path.join(MC, randomName('.rconsole-restore'));
  let src;
  try {
    src = fs.openSync(path.join(BK, file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    fail('Backup not found');
  }
  try {
    if (!fs.fstatSync(src).isFile()) fail('Backup not found');
    const dst = fs.openSync(archive, EXCL, 0o600);
    try {
      const buf = Buffer.alloc(1 << 20);
      let n;
      while ((n = fs.readSync(src, buf, 0, buf.length, null)) > 0) fs.writeSync(dst, buf, 0, n);
    } finally {
      fs.closeSync(dst);
    }
  } finally {
    fs.closeSync(src);
  }
  try {
    return await restoreFrom(archive, file, target, replace);
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

async function restoreFrom(archive, file, target, replace) {
  const flag = unpackFlag(file);
  const base = await inspectArchive(archive, flag);

  const existing = worldDirs(target);
  if (existing.length && !replace) fail(`A world named "${target}" already exists`);

  const stamp = names.timestamp();
  const parked = [];
  try {
    for (const d of existing) {
      const aside = path.join(MC, `.restore-old-${stamp}-${d}`);
      fs.renameSync(path.join(MC, d), aside);
      parked.push([aside, path.join(MC, d)]);
    }
    const esc = (s) => s.replace(/[.\\^$*[\]]/g, '\\$&');
    await run('tar', [
      '-x', flag, '-f', archive, '-C', MC, '--no-same-owner',
      `--transform=s,^${esc(base)}_nether\\(/\\|$\\),${target}_nether\\1,`,
      `--transform=s,^${esc(base)}_the_end\\(/\\|$\\),${target}_the_end\\1,`,
      `--transform=s,^${esc(base)}\\(/\\|$\\),${target}\\1,`,
    ]);
  } catch (err) {
    for (const d of names.DIMENSIONS) fs.rmSync(path.join(MC, target + d), { recursive: true, force: true });
    for (const [aside, orig] of parked) fs.renameSync(aside, orig);
    throw err;
  }
  for (const [aside] of parked) fs.rmSync(aside, { recursive: true, force: true });
  for (const d of worldDirs(target)) groupReadable(path.join(MC, d)); // the archive's modes may lock rconsole out
  return { restored: file, world: target, from: base, replaced: parked.length > 0 };
}

// --- worlds -----------------------------------------------------------------

// rconsole reads worlds through the minecraft group (sizes, dimensions,
// player data). Folders extracted from an archive keep the archive's modes,
// and a world copied from an older setup can be 0700: the group then sees
// nothing below it. Adds group read (and search, for folders); links are
// left alone, nothing is made writable.
function groupReadable(root) {
  let changed = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    const want = st.isDirectory() ? 0o050 : 0o040;
    if ((st.mode & want) !== want) {
      fs.chmodSync(dir, (st.mode & 0o7777) | want);
      changed++;
    }
    if (st.isDirectory()) for (const e of fs.readdirSync(dir)) stack.push(path.join(dir, e));
  }
  return changed;
}

async function worldAccess({ world }) {
  checkWorld(world);
  let changed = 0;
  for (const d of worldDirs(world)) changed += groupReadable(path.join(MC, d));
  return { world, changed };
}

async function deleteWorld({ world, archive }) {
  checkWorld(world);
  if (world === (await activeWorld())) fail('The active world can’t be deleted');
  const dirs = worldDirs(world);
  if (!dirs.length) fail(`World "${world}" not found`);
  let archived = null;
  if (archive) archived = (await backup({ world, stamp: names.timestamp() })).file;
  for (const d of dirs) fs.rmSync(path.join(MC, d), { recursive: true, force: true });
  return { deleted: world, archived };
}

// --- server.properties --------------------------------------------------------

async function setProperties({ set, world }) {
  const updates = settings.normalizeAll(set, { allowWorldKeys: Boolean(world) });
  const file = path.join(MC, 'server.properties');
  const doc = properties.set(properties.parse(fs.readFileSync(file, 'utf8')), updates);
  const tmp = path.join(MC, `.server.properties.rconsole-${process.pid}`);
  fs.writeFileSync(tmp, properties.stringify(doc), { mode: fs.statSync(file).mode & 0o777 });
  fs.renameSync(tmp, file);
  return { changed: updates };
}

// --- Paper ------------------------------------------------------------------

async function fetchVerified(url, algo, expected, userAgent) {
  const res = await fetch(url, { headers: { 'User-Agent': userAgent }, redirect: 'follow' });
  if (!res.ok) fail(`Download failed: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const actual = crypto.createHash(algo).update(body).digest('hex');
  if (actual !== expected) fail(`Checksum mismatch (expected ${expected}, got ${actual})`);
  return body;
}

async function paperUpdate({ version, build, rollback }) {
  const previous = `${jar}.previous`;
  if (rollback) {
    if (!exists(previous)) fail('No previous jar to roll back to');
    const swap = `${jar}.swap`;
    fs.renameSync(jar, swap);
    fs.renameSync(previous, jar);
    fs.renameSync(swap, previous);
    return { rolledBack: true };
  }
  if (!/^\d+(\.\d+)+$/.test(String(version)) || !Number.isInteger(build) || build < 1) fail('Invalid update target');
  // Which project (paper/folia) is decided here from MC_DIR, not by rconsole.
  const pf = platform.detect(MC);
  if (!pf.updates) fail(`Automatic updates aren't available for ${pf.name}`);
  const download = await distributions.resolve(pf.updates, version, build);
  const body = await fetchVerified(download.url, download.algo, download.hash, distributions.USER_AGENT);
  const tmp = path.join(MC, `.${config.mcJar}.download`);
  try {
    fs.writeFileSync(tmp, body, { mode: 0o640 });
    if (exists(jar)) fs.copyFileSync(jar, previous);
    // Rename is atomic; the running JVM keeps the old inode until restart.
    fs.renameSync(tmp, jar);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { version, build, sha256: download.hash, size: download.size };
}

// --- plugins ------------------------------------------------------------------

// plugins/ or mods/ depending on the server software, decided here from
// MC_DIR rather than taken from rconsole.
let pluginsDir;
let previousDir;
let previousIndexFile;
let addonLoaders;
function useAddonDir() {
  const pf = platform.detect(MC);
  if (!pf.addons) fail(`${pf.name} loads no plugins or mods`);
  pluginsDir = path.join(MC, pf.addons.dir);
  previousDir = path.join(pluginsDir, '.rconsole-previous');
  previousIndexFile = path.join(previousDir, 'index.json');
  addonLoaders = pf.loaders;
  return pf;
}

function pluginFile(file) {
  if (!PLUGIN_FILE_RE.test(String(file)) || path.basename(file) !== file) fail('Invalid plugin file name');
  return file;
}

const readIndex = () => {
  try {
    return JSON.parse(fs.readFileSync(previousIndexFile, 'utf8'));
  } catch {
    return {};
  }
};
function writeIndex(index) {
  fs.mkdirSync(previousDir, { recursive: true });
  fs.writeFileSync(`${previousIndexFile}.tmp`, JSON.stringify(index, null, 2));
  fs.renameSync(`${previousIndexFile}.tmp`, previousIndexFile);
}

// The sha512 of every jar rconsole installed, per server, in BACKUP_DIR
// (hidden from the servers). rconsole flags a jar that changed since: a
// plugin or malware rewriting other jars. Keys leave out ".disabled".
const pluginKey = (file) => file.replace(/\.disabled$/, '');
const hashesFile = () => path.join(realDir(path.join(BK, '.plugin-hashes')), `${path.dirname(MC) === config.serversDir ? path.basename(MC) : 'attached'}.json`);
function recordPlugins(changes) {
  const file = hashesFile();
  let known = {};
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      known = JSON.parse(fs.readFileSync(fd, 'utf8')) || {};
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  for (const [name, sha512] of Object.entries(changes)) {
    if (sha512) known[pluginKey(name)] = sha512;
    else delete known[pluginKey(name)];
  }
  writeExclusive(file, JSON.stringify(known));
}
const sha512Of = (file) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('hex');

// Moves a plugin jar out of the way into BACKUP_DIR/.plugin-trash.
function trashPlugin(file) {
  const dir = realDir(path.join(BK, '.plugin-trash'));
  const dest = path.join(dir, `${names.timestamp()}-${file}`);
  fs.copyFileSync(path.join(pluginsDir, file), dest, fs.constants.COPYFILE_EXCL);
  fs.rmSync(path.join(pluginsDir, file));
  return path.basename(dest);
}

// Installs a Modrinth version (re-resolved here, never taken from rconsole),
// optionally replacing an installed jar that is kept for rollback.
async function pluginInstall({ versionId, replace }) {
  useAddonDir();
  const version = await modrinth.version(String(versionId));
  if (!(version.loaders || []).some((l) => addonLoaders.includes(l))) fail(`This release is for ${(version.loaders || []).join(', ') || 'another loader'}, not this server`);
  const file = modrinth.primaryFile(version);
  if (replace) {
    pluginFile(replace);
    if (!exists(path.join(pluginsDir, replace))) fail(`${replace} is not installed`);
  } else if (exists(path.join(pluginsDir, file.filename)) || exists(path.join(pluginsDir, `${file.filename}.disabled`))) {
    fail(`${file.filename} is already installed`);
  }
  const body = await fetchVerified(file.url, 'sha512', file.sha512, modrinth.USER_AGENT);
  fs.mkdirSync(pluginsDir, { recursive: true });
  const tmp = path.join(pluginsDir, `.${file.filename}.download`);
  fs.writeFileSync(tmp, body, { mode: 0o640 });
  try {
    if (replace) {
      fs.mkdirSync(previousDir, { recursive: true });
      fs.copyFileSync(path.join(pluginsDir, replace), path.join(previousDir, replace));
      if (replace !== file.filename) fs.rmSync(path.join(pluginsDir, replace));
      const index = readIndex();
      index[file.filename] = replace;
      writeIndex(index);
    }
    fs.renameSync(tmp, path.join(pluginsDir, file.filename));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  recordPlugins({ ...(replace && replace !== file.filename ? { [replace]: null } : {}), [file.filename]: file.sha512 });
  return { file: file.filename, version: version.version_number, projectId: version.project_id, replaced: replace || null };
}

async function pluginToggle({ file, enabled }) {
  useAddonDir();
  pluginFile(file);
  const isDisabled = file.endsWith('.disabled');
  if (Boolean(enabled) === !isDisabled) fail(enabled ? 'Already enabled' : 'Already disabled');
  const to = enabled ? file.replace(/\.disabled$/, '') : `${file}.disabled`;
  if (exists(path.join(pluginsDir, to))) fail(`${to} already exists`);
  fs.renameSync(path.join(pluginsDir, file), path.join(pluginsDir, to));
  return { file: to, enabled: Boolean(enabled) };
}

async function pluginRemove({ file }) {
  useAddonDir();
  pluginFile(file);
  if (!exists(path.join(pluginsDir, file))) fail(`${file} not found`);
  const trashed = trashPlugin(file);
  recordPlugins({ [file]: null });
  return { removed: file, trashed };
}

async function pluginRollback({ file }) {
  useAddonDir();
  pluginFile(file);
  const index = readIndex();
  const previous = index[file];
  if (!previous || !PLUGIN_FILE_RE.test(previous) || !exists(path.join(previousDir, previous))) fail('No previous version to roll back to');
  if (exists(path.join(pluginsDir, file))) trashPlugin(file);
  fs.renameSync(path.join(previousDir, previous), path.join(pluginsDir, previous));
  delete index[file];
  writeIndex(index);
  // The old jar comes from rconsole's own copy, as it was when replaced.
  recordPlugins({ [file]: null, [previous]: sha512Of(path.join(pluginsDir, previous)) });
  return { file: previous, rolledBackFrom: file };
}

// --- dispatch -----------------------------------------------------------------

// --- plugin and mod configs ---------------------------------------------------

// Writes a config file atomically, keeping the old one in
// <root>/.rconsole-previous/… for "Revert". Paths are checked again here:
// under the config root, allowed extension, no links on the way.
async function configWrite({ file, content, revert = false }) {
  const root = configs.rootOf(MC);
  const parts = configs.checkPath(file, root);
  const target = configs.noLinks(MC, parts);
  const prevParts = [root, '.rconsole-previous', ...parts.slice(1)];
  const prevFile = path.join(MC, ...prevParts);
  let next;
  if (revert) {
    configs.noLinks(MC, prevParts);
    next = fs.readFileSync(prevFile);
  } else {
    if (typeof content !== 'string') fail('Missing content');
    const problem = configs.validate(file, content);
    if (problem) fail(problem);
    next = Buffer.from(content, 'utf8');
  }
  // Read the current file through a no-follow descriptor before replacing it.
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let current;
  try {
    current = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let dir = MC;
  for (const p of prevParts.slice(0, -1)) dir = realDir(path.join(dir, p));
  writeExclusive(prevFile, current);
  writeExclusive(target, next, fs.statSync(target).mode & 0o777);
  return { file, bytes: next.length, reverted: Boolean(revert) };
}

const TASKS = {
  backup,
  restore,
  'world-delete': deleteWorld,
  'world-access': worldAccess,
  properties: setProperties,
  'paper-update': paperUpdate,
  'plugin-install': pluginInstall,
  'plugin-toggle': pluginToggle,
  'plugin-remove': pluginRemove,
  'plugin-rollback': pluginRollback,
  'config-write': configWrite,
  ...servers.TASKS,
};

function writeResult(file, result) {
  // 0750 under UMask=0027: rconsole (group, inherited from the setgid backup
  // dir) reads results, only the helper writes. No chmod: the units set
  // RestrictSUIDSGID, which refuses touching the setgid bit.
  writeExclusive(path.join(realDir(jobsDir), file), JSON.stringify({ ...result, finished: new Date().toISOString() }));
}

// Results older than 30 days go, except the newest server update (rconsole
// shows its version when the log doesn't). Only plain files are removed.
function pruneResults(now = Date.now()) {
  const old = [];
  let keep = null;
  for (const f of fs.readdirSync(jobsDir)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(jobsDir, f);
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st?.isFile()) continue;
    if (now - st.mtimeMs > 30 * 86400 * 1000) old.push([p, st.mtimeMs]);
  }
  for (const [p] of old.sort((a, b) => b[1] - a[1])) {
    if (!keep) {
      try {
        const r = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (r?.ok && r.version && r.build) {
          keep = p;
          continue;
        }
      } catch {}
    }
    fs.rmSync(p, { force: true });
  }
}

async function main() {
  const [mode, arg] = process.argv.slice(2);
  let kind;
  let args;
  let resultFile;
  let instance = null;

  if (mode === 'job') {
    if (!names.JOB_ID_RE.test(arg || '')) fail('Invalid job id');
    const request = JSON.parse(fs.readFileSync(path.join(BK, '.requests', `${arg}.json`), 'utf8'));
    kind = String(request.kind);
    args = request.args && typeof request.args === 'object' ? request.args : {};
    resultFile = `${arg}.json`;
    instance = request.instance ?? null;
  } else if (mode === 'backup') {
    [kind, args, resultFile] = ['backup', { stamp: arg }, `backup-${arg}.json`];
  } else if (mode === 'update') {
    const m = /^([\d.]+)_(\d+)$/.exec(arg || '');
    args = arg === 'rollback' ? { rollback: true } : m ? { version: m[1], build: Number(m[2]) } : {};
    [kind, resultFile] = ['paper-update', `update-${arg}.json`];
  } else {
    console.error('usage: mc-helper.js job <id>');
    process.exit(2);
  }

  if (!Object.hasOwn(TASKS, kind)) {
    writeResult(resultFile, { ok: false, kind, error: `Unknown job kind ${kind}` });
    process.exit(1);
  }
  try {
    // The active server rconsole works on. Only a valid instance in
    // SERVERS_DIR is accepted; every path check then applies to its folder.
    if (instance !== null && !Object.hasOwn(servers.TASKS, kind)) {
      const i = instances.read(config.serversDir, instance);
      MC = path.join(config.serversDir, i.id);
      jar = path.join(MC, i.launch?.type === 'jar' ? i.launch.path : 'server.jar');
    }
    const result = await TASKS[kind](args);
    writeResult(resultFile, { ok: true, kind, ...result });
    try {
      pruneResults();
    } catch (err) {
      console.error(`pruning old results: ${err.message}`);
    }
    console.log(`${kind}: ok`);
  } catch (err) {
    writeResult(resultFile, { ok: false, kind, error: err.message });
    console.error(`${kind}: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { TASKS, pruneResults };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

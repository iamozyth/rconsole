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
const paper = require('../lib/paper');
const names = require('../lib/names');
const modrinth = require('../lib/modrinth');
const { FILE_RE: PLUGIN_FILE_RE } = require('../lib/plugins');

const MC = config.mcDir;
const BK = config.backupDir;
const jobsDir = path.join(BK, '.jobs');
const jar = path.join(MC, config.mcJar);

const fail = (msg) => {
  throw new Error(msg);
};

function run(cmd, args, { okCodes = [0], capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'pipe'] });
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

const worldDirs = (world) => names.DIMENSIONS.map((d) => world + d).filter((d) => exists(path.join(MC, d)));

async function activeWorld() {
  return (await readProperties(MC))['level-name'] || 'world';
}

function checkWorld(world) {
  if (!names.isWorldName(world)) fail('Invalid world name');
  return world;
}

// --- backup -----------------------------------------------------------------

async function backup({ world, stamp }) {
  world = checkWorld(world || (await activeWorld()));
  if (!names.STAMP_RE.test(stamp || '')) fail('Invalid backup timestamp');
  const dirs = worldDirs(world);
  if (!dirs.length) fail(`No world folder "${world}" in ${MC}`);

  const name = `${world}-${stamp}.tar.gz`;
  const final = path.join(BK, name);
  const partial = `${final}.partial`;
  try {
    // tar exit 1 = "file changed as we read it", fine for region files.
    await run('tar', ['-czf', partial, '-C', MC, '--', ...dirs], { okCodes: [0, 1] });
    fs.chmodSync(partial, 0o640);
    fs.renameSync(partial, final);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
  return { file: name, world, size: fs.statSync(final).size, dirs };
}

// --- restore ----------------------------------------------------------------

// Lists an archive and refuses anything but plain files and directories under
// one world's three dimension folders.
async function inspectArchive(file) {
  const listing = await run('tar', ['-tvzf', file], { capture: true });
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
  const archive = path.join(BK, file);
  if (!exists(archive) || !fs.statSync(archive).isFile()) fail('Backup not found');
  const base = await inspectArchive(archive);

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
      '-xzf', archive, '-C', MC, '--no-same-owner',
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
  return { restored: file, world: target, from: base, replaced: parked.length > 0 };
}

// --- worlds -----------------------------------------------------------------

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
  const download = await paper.download(version, build);
  const body = await fetchVerified(download.url, 'sha256', download.sha256, paper.USER_AGENT);
  const tmp = path.join(MC, `.${config.mcJar}.download`);
  try {
    fs.writeFileSync(tmp, body, { mode: 0o640 });
    if (exists(jar)) fs.copyFileSync(jar, previous);
    // Rename is atomic; the running JVM keeps the old inode until restart.
    fs.renameSync(tmp, jar);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { version, build, sha256: download.sha256, size: download.size };
}

// --- plugins ------------------------------------------------------------------

const pluginsDir = path.join(MC, 'plugins');
const previousDir = path.join(pluginsDir, '.rconsole-previous');
const previousIndexFile = path.join(previousDir, 'index.json');

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

// Moves a plugin jar out of the way into BACKUP_DIR/.plugin-trash.
function trashPlugin(file) {
  const dir = path.join(BK, '.plugin-trash');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${names.timestamp()}-${file}`);
  fs.copyFileSync(path.join(pluginsDir, file), dest);
  fs.rmSync(path.join(pluginsDir, file));
  return path.basename(dest);
}

// Installs a Modrinth version (re-resolved here, never taken from rconsole),
// optionally replacing an installed jar that is kept for rollback.
async function pluginInstall({ versionId, replace }) {
  const version = await modrinth.version(String(versionId));
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
  return { file: file.filename, version: version.version_number, projectId: version.project_id, replaced: replace || null };
}

async function pluginToggle({ file, enabled }) {
  pluginFile(file);
  const isDisabled = file.endsWith('.disabled');
  if (Boolean(enabled) === !isDisabled) fail(enabled ? 'Already enabled' : 'Already disabled');
  const to = enabled ? file.replace(/\.disabled$/, '') : `${file}.disabled`;
  if (exists(path.join(pluginsDir, to))) fail(`${to} already exists`);
  fs.renameSync(path.join(pluginsDir, file), path.join(pluginsDir, to));
  return { file: to, enabled: Boolean(enabled) };
}

async function pluginRemove({ file }) {
  pluginFile(file);
  if (!exists(path.join(pluginsDir, file))) fail(`${file} not found`);
  return { removed: file, trashed: trashPlugin(file) };
}

async function pluginRollback({ file }) {
  pluginFile(file);
  const index = readIndex();
  const previous = index[file];
  if (!previous || !PLUGIN_FILE_RE.test(previous) || !exists(path.join(previousDir, previous))) fail('No previous version to roll back to');
  if (exists(path.join(pluginsDir, file))) trashPlugin(file);
  fs.renameSync(path.join(previousDir, previous), path.join(pluginsDir, previous));
  delete index[file];
  writeIndex(index);
  return { file: previous, rolledBackFrom: file };
}

// --- dispatch -----------------------------------------------------------------

const TASKS = {
  backup,
  restore,
  'world-delete': deleteWorld,
  properties: setProperties,
  'paper-update': paperUpdate,
  'plugin-install': pluginInstall,
  'plugin-toggle': pluginToggle,
  'plugin-remove': pluginRemove,
  'plugin-rollback': pluginRollback,
};

function writeResult(file, result) {
  // 0750 under UMask=0027: rconsole (group, inherited from the setgid backup
  // dir) reads results, only the helper writes. No chmod: the units set
  // RestrictSUIDSGID, which refuses touching the setgid bit.
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o750 });
  const out = path.join(jobsDir, file);
  fs.writeFileSync(`${out}.tmp`, JSON.stringify({ ...result, finished: new Date().toISOString() }), { mode: 0o640 });
  fs.renameSync(`${out}.tmp`, out);
}

async function main() {
  const [mode, arg] = process.argv.slice(2);
  let kind;
  let args;
  let resultFile;

  if (mode === 'job') {
    if (!names.JOB_ID_RE.test(arg || '')) fail('Invalid job id');
    const request = JSON.parse(fs.readFileSync(path.join(BK, '.requests', `${arg}.json`), 'utf8'));
    kind = String(request.kind);
    args = request.args && typeof request.args === 'object' ? request.args : {};
    resultFile = `${arg}.json`;
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
    const result = await TASKS[kind](args);
    writeResult(resultFile, { ok: true, kind, ...result });
    console.log(`${kind}: ok`);
  } catch (err) {
    writeResult(resultFile, { ok: false, kind, error: err.message });
    console.error(`${kind}: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { TASKS };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

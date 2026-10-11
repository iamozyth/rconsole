#!/usr/bin/env node
'use strict';

// Privileged half of rconsole. Runs as the Minecraft user (via the
// rconsole-backup@ / rconsole-update@ systemd units) and does exactly two
// things: archive the world folders, and swap the Paper jar for a verified
// download or the previous jar. rconsole itself never writes to MC_DIR.
//
//   mc-helper.js backup <YYYY-MM-DD_HH-MM-SS>
//   mc-helper.js update <version>_<build>
//   mc-helper.js update rollback
//
// The outcome is written to BACKUP_DIR/.jobs/<kind>-<instance>.json.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('../lib/config');
const { readProperties } = require('../lib/access');
const paper = require('../lib/paper');

const [kind, instance] = process.argv.slice(2);
const jobsDir = path.join(config.backupDir, '.jobs');
const jar = path.join(config.mcDir, config.mcJar);

function writeResult(result) {
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.chmodSync(jobsDir, 0o2750); // rconsole (group) reads results, only the helper writes
  const file = path.join(jobsDir, `${kind}-${instance}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...result, finished: new Date().toISOString() }), { mode: 0o640 });
  fs.renameSync(`${file}.tmp`, file);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    // tar exit 1 = "file changed as we read it", fine for region files.
    child.on('close', (code) => (code <= 1 ? resolve() : reject(new Error(stderr.trim() || `${cmd} exited with ${code}`))));
  });
}

async function backup(stamp) {
  if (!/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(stamp)) throw new Error('invalid backup name');
  const level = (await readProperties(config.mcDir))['level-name'] || 'world';
  const worlds = [level, `${level}_nether`, `${level}_the_end`].filter((d) => {
    try {
      return fs.statSync(path.join(config.mcDir, d)).isDirectory();
    } catch {
      return false;
    }
  });
  if (!worlds.length) throw new Error(`No world folder "${level}" in ${config.mcDir}`);

  const name = `world-${stamp}.tar.gz`;
  const final = path.join(config.backupDir, name);
  const partial = `${final}.partial`;
  try {
    await run('tar', ['-czf', partial, '-C', config.mcDir, ...worlds]);
    fs.chmodSync(partial, 0o640);
    fs.renameSync(partial, final);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  }
  return { file: name, size: fs.statSync(final).size, worlds };
}

async function update(spec) {
  const previous = `${jar}.previous`;

  if (spec === 'rollback') {
    if (!fs.existsSync(previous)) throw new Error('No previous jar to roll back to');
    const swap = `${jar}.swap`;
    fs.renameSync(jar, swap);
    fs.renameSync(previous, jar);
    fs.renameSync(swap, previous);
    return { rolledBack: true };
  }

  const m = /^(\d+(?:\.\d+)+)_(\d+)$/.exec(spec || '');
  if (!m) throw new Error('invalid update target');
  const [, version, buildId] = m;

  const download = await paper.download(version, Number(buildId));
  const tmp = path.join(config.mcDir, `.${config.mcJar}.download`);
  try {
    const res = await fetch(download.url, { headers: { 'User-Agent': paper.USER_AGENT }, redirect: 'follow' });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    const body = Buffer.from(await res.arrayBuffer());
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    if (sha256 !== download.sha256) throw new Error(`Checksum mismatch (expected ${download.sha256}, got ${sha256})`);
    fs.writeFileSync(tmp, body, { mode: 0o640 });
    if (fs.existsSync(jar)) fs.copyFileSync(jar, previous);
    // Rename is atomic; the running JVM keeps the old inode until restart.
    fs.renameSync(tmp, jar);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { version, build: Number(buildId), sha256: download.sha256, size: download.size };
}

const tasks = { backup, update };

(async () => {
  if (!tasks[kind] || !instance) {
    console.error('usage: mc-helper.js <backup|update> <instance>');
    process.exit(2);
  }
  try {
    const result = await tasks[kind](instance);
    writeResult({ ok: true, ...result });
    console.log(`${kind} ${instance}: ok`);
  } catch (err) {
    writeResult({ ok: false, error: err.message });
    console.error(`${kind} ${instance}: ${err.message}`);
    process.exit(1);
  }
})();

'use strict';

// Update rehearsal (lib/rehearsal.js): a copy of an installed server starts
// once with what it runs now and once with the update, next to the real
// server, and rconsole compares the two startups. Part of the privileged
// helper (bin/mc-helper.js), as the Minecraft user:
//
//   rehearsal-prepare (rconsole-net@: downloads) copies the server to
//     BACKUP_DIR/.rehearsals/<token>/ (worlds only around 0,0), puts the new
//     version beside the current one, and lets it fetch what it needs.
//   rehearsal-boot (rconsole-try@: this machine only, no internet) starts
//     the copy with one of the two, until it is up or gives up, and stops it.
//   rehearsal-clean removes the copy.
//
// The copy listens on 127.0.0.1 only, RCON and query off, so no player can
// reach it; the unit keeps it from reaching anything beyond this machine.

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('../lib/config');
const distributions = require('../lib/distributions');
const java = require('../lib/java');
const instances = require('../lib/instances');
const properties = require('../lib/properties');
const servers = require('./mc-servers');

const SV = config.serversDir;
const ROOT = path.join(config.backupDir, '.rehearsals');
const TOKEN_RE = /^[a-f0-9]{16}$/;
const MAX_COPY = 6 * 1024 ** 3;
const MAX_FILE = 256 * 1024 ** 2;
const PORTS = [25700, 25799];
const BOOT_MS = 6 * 60 * 1000;
const SETTLE_MS = 15 * 1000;
const STOP_MS = 90 * 1000;
// Distributions whose new version fetches what it needs before starting
// (paperclip's patch-only run, an installer) or needs nothing (vanilla).
const PATCHONLY = new Set(['paper', 'folia', 'purpur']);
const { SUPPORTED } = require('../lib/rehearsal');
// Map renderers' tiles and backups: large, and nothing a startup reads.
const SKIP_TOP = new Set(['logs', 'crash-reports', 'debug', 'bluemap', 'backups', 'world-backups']);
const SKIP_PLUGIN_DIRS = [/^BlueMap\/web$/, /^dynmap\/web$/, /^squaremap\/web$/, /^Pl3xMap\/web$/, /^[^/]+\/backups?$/i];
// World data: only the regions around 0,0 (spawn is nearly always there).
const KIND_DIRS = new Set(['region', 'entities', 'poi']);
const SPAWN_REGIONS = new Set(['r.0.0.mca', 'r.-1.0.mca', 'r.0.-1.mca', 'r.-1.-1.mca']);

const fail = (msg) => {
  throw new Error(msg);
};

function dirOf(token) {
  if (!TOKEN_RE.test(String(token))) fail('Invalid rehearsal');
  const dir = path.join(ROOT, token);
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st?.isDirectory()) fail('This rehearsal is gone');
  return dir;
}

// What a copy takes: [relative path, size] of the files it copies, and
// what it leaves out.
function plan(src) {
  const files = [];
  const skipped = { worldRegions: 0, large: [], links: 0 };
  let total = 0;
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        skipped.links++;
        continue;
      }
      if (!rel && (SKIP_TOP.has(e.name) || e.name.startsWith('.rconsole'))) continue;
      if (e.isDirectory()) {
        if (r.startsWith('plugins/') && SKIP_PLUGIN_DIRS.some((re) => re.test(r.slice(8)))) {
          skipped.large.push(r);
          continue;
        }
        walk(r);
      } else if (e.isFile()) {
        if (KIND_DIRS.has(path.basename(rel)) && /\.(mca|mcc)$/.test(e.name) && !SPAWN_REGIONS.has(e.name)) {
          skipped.worldRegions++;
          continue;
        }
        const size = fs.statSync(path.join(src, r)).size;
        if (size > MAX_FILE) {
          skipped.large.push(r);
          continue;
        }
        files.push([r, size]);
        total += size;
      }
    }
  };
  walk('');
  return { files, total, skipped };
}

function copy(src, dest, files) {
  for (const [rel] of files) {
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o750 });
    fs.copyFileSync(path.join(src, rel), to, fs.constants.COPYFILE_FICLONE);
  }
}

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

async function freePort() {
  const used = new Set(instances.list(SV).map((i) => i.port));
  for (let p = PORTS[0]; p <= PORTS[1]; p++) if (!used.has(p) && (await portFree(p))) return p;
  fail('No free port for the rehearsal');
}

// Leftovers of rehearsals that never finished (rconsole restarted).
function pruneOld(now = Date.now()) {
  if (!fs.existsSync(ROOT)) return;
  for (const name of fs.readdirSync(ROOT)) {
    const p = path.join(ROOT, name);
    const st = fs.lstatSync(p);
    if (st.isDirectory() && !st.isSymbolicLink() && now - st.mtimeMs > 6 * 3600 * 1000) fs.rmSync(p, { recursive: true, force: true });
  }
}

async function rehearsalPrepare({ id, version, build = null, memoryMb }) {
  const current = instances.read(SV, id);
  if (current.kind === 'proxy') fail('Proxies are not rehearsed');
  if (!SUPPORTED.has(current.distribution)) fail(`Rehearsals aren't available for ${current.distribution} yet`);
  if (!current.launch) fail(`${id} is not installed yet`);
  const mem = Math.round(Number(memoryMb));
  if (!(mem >= 512 && mem <= current.memoryMb)) fail('Invalid memory');
  const resolved = await distributions.resolve(current.distribution, version, build);
  if (resolved.version === current.version && resolved.build === current.build) fail(`${id} already runs ${version}${build ? ` #${build}` : ''}`);

  pruneOld();
  const src = path.join(SV, id);
  const p = plan(src);
  if (p.total > MAX_COPY) fail(`The copy would be ${(p.total / 1024 ** 3).toFixed(1)} GB; rehearsals copy at most ${MAX_COPY / 1024 ** 3} GB`);
  const free = fs.statfsSync(config.backupDir);
  if (free.bavail * free.bsize < p.total + 1024 ** 3) fail(`Not enough free disk space for a copy of ${(p.total / 1024 ** 3).toFixed(1)} GB`);

  fs.mkdirSync(ROOT, { recursive: true, mode: 0o750 });
  const token = crypto.randomBytes(8).toString('hex');
  const dir = path.join(ROOT, token);
  fs.mkdirSync(dir, { mode: 0o750 });
  try {
    const server = path.join(dir, 'server');
    fs.mkdirSync(server, { mode: 0o750 });
    copy(src, server, p.files);

    // Reachable from this machine only, and nothing that talks to players.
    const port = await freePort();
    const propsFile = path.join(server, 'server.properties');
    const doc = properties.parse(fs.existsSync(propsFile) ? fs.readFileSync(propsFile, 'utf8') : '');
    fs.writeFileSync(propsFile, properties.stringify(properties.set(doc, {
      'server-ip': '127.0.0.1', 'server-port': String(port), 'enable-rcon': 'false', 'enable-query': 'false', 'white-list': 'true', 'enforce-whitelist': 'true',
      motd: 'rconsole update rehearsal',
    })), { mode: 0o640 });

    // The new version beside the current one.
    const major = await java.majorFor(current.distribution, resolved.version);
    await servers.javaInstall({ major });
    const javaBin = path.join(SV, '.java', String(major), 'bin', 'java');
    const body = await servers.download(resolved);
    let launch;
    if (resolved.install === 'installer') {
      fs.writeFileSync(path.join(server, resolved.file), body, { mode: 0o640 });
      await servers.run(javaBin, ['-jar', resolved.file, ...resolved.installArgs], { cwd: server, timeoutMs: 14 * 60 * 1000 });
      fs.rmSync(path.join(server, resolved.file), { force: true });
      launch = servers.findLaunch(server, resolved);
    } else {
      // Never over the jar the current version starts from.
      const file = resolved.file === current.launch.path ? `rehearsal-${resolved.file}` : resolved.file;
      fs.writeFileSync(path.join(server, file), body, { mode: 0o640 });
      launch = { type: 'jar', path: file };
      // Paperclip fetches the game and its libraries, patches, and exits.
      if (PATCHONLY.has(current.distribution)) await servers.run(javaBin, ['-Dpaperclip.patchonly=true', '-jar', file], { cwd: server, timeoutMs: 10 * 60 * 1000 });
    }
    if (!launch) fail(`The ${resolved.distribution} update was installed, but nothing to start was found`);

    const meta = {
      id, port, memoryMb: mem, at: new Date().toISOString(), instance: current,
      current: { version: current.version, build: current.build, java: current.java, launch: current.launch },
      next: { version: resolved.version, build: resolved.build, java: major, launch },
      copied: { files: p.files.length, bytes: p.total, worldRegionsLeftOut: p.skipped.worldRegions, leftOut: p.skipped.large.slice(0, 20), links: p.skipped.links },
    };
    fs.writeFileSync(path.join(dir, 'rehearsal.json'), JSON.stringify(meta), { mode: 0o640 });
    return { token, ...meta };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

// The lines worth reading: warnings, errors and what follows them (stack
// traces), what plugins and the server say about starting, and the end.
const NOTABLE = /\b(WARN|ERROR|FATAL)\]|Enabling |Disabling |Could not load|Done \(|Starting minecraft server|Stopping server|Exception|Error:|Caused by|^\s+at /;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

function boot(dir, argv, { bootMs = BOOT_MS, settleMs = SETTLE_MS, stopMs = STOP_MS } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(argv[0], argv.slice(1), { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    const notable = [];
    const tail = [];
    let partial = '';
    let doneAt = null;
    let timedOut = false;
    let stopping = false;
    const take = (chunk) => {
      const lines = (partial + chunk).replace(ANSI, '').split(/\r?\n/);
      partial = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        tail.push(line.slice(0, 500));
        if (tail.length > 80) tail.shift();
        if (notable.length < 1500 && NOTABLE.test(line)) notable.push(line.slice(0, 500));
        if (doneAt == null && /Done \(\d+[.,]?\d*s\)!/.test(line)) {
          doneAt = Date.now();
          setTimeout(stop, settleMs);
        }
      }
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      try {
        child.stdin.write('stop\n');
      } catch {}
      setTimeout(() => child.kill('SIGKILL'), stopMs).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, bootMs);
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.stdin.on('error', () => {});
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ up: false, error: err.message, notable, tail });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (partial) take('\n');
      resolve({ up: doneAt != null, seconds: doneAt ? Math.round((doneAt - started) / 100) / 10 : null, exit: code, signal, timedOut, stoppedByUs: stopping, notable, tail: tail.slice(-60), crash: crashReport(dir, started) });
    });
  });
}

// A crash report written during this start, shortened.
function crashReport(dir, since) {
  const crashes = path.join(dir, 'crash-reports');
  try {
    const newest = fs.readdirSync(crashes).filter((f) => f.endsWith('.txt')).map((f) => [f, fs.lstatSync(path.join(crashes, f))]).filter(([, st]) => st.isFile() && st.mtimeMs >= since).sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)[0];
    return newest ? fs.readFileSync(path.join(crashes, newest[0]), 'utf8').split('\n').slice(0, 40).join('\n') : null;
  } catch {
    return null;
  }
}

async function rehearsalBoot({ token, which }) {
  const dir = dirOf(token);
  if (!['current', 'next'].includes(which)) fail('Invalid start');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'rehearsal.json'), 'utf8'));
  const v = meta[which];
  // From the copy's notes: the servers folder is hidden in rconsole-try@.
  const inst = instances.validate({ ...meta.instance, memoryMb: meta.memoryMb, java: v.java, launch: v.launch });
  const server = path.join(dir, 'server');
  if (!fs.existsSync(path.join(server, 'logs'))) fs.mkdirSync(path.join(server, 'logs'), { mode: 0o750 });
  const argv = instances.command(inst, path.join(SV, '.java', String(v.java)));
  return { which, version: v.version, build: v.build, ...(await boot(server, argv)) };
}

async function rehearsalClean({ token }) {
  if (!TOKEN_RE.test(String(token))) fail('Invalid rehearsal');
  fs.rmSync(path.join(ROOT, token), { recursive: true, force: true });
  return { removed: token };
}

module.exports = {
  TASKS: { 'rehearsal-prepare': rehearsalPrepare, 'rehearsal-boot': rehearsalBoot, 'rehearsal-clean': rehearsalClean },
  plan,
  boot,
};

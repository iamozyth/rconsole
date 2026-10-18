'use strict';

// Servers rconsole installs and runs: one folder per instance in SERVERS_DIR,
// described by its instance.json. The same validation runs in rconsole, in
// the helper that writes the file and in the launcher that starts Java from
// it, so the java command line is only ever built from checked fields.

const fs = require('fs');
const path = require('path');
const distributions = require('./distributions');

const { VERSION_RE, LOADER_RE } = distributions;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Relative path below the instance folder: plain names, no "..", no options.
const LAUNCH_PATH_RE = /^(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9_][A-Za-z0-9_.+-]*(\/[A-Za-z0-9_][A-Za-z0-9_.+-]*)*$/;
const LAUNCH_TYPES = new Set(['jar', 'argsfile']);
const DIST_IDS = new Set(distributions.list().map((d) => d.id));
const KIND = Object.fromEntries(distributions.list().map((d) => [d.id, d.kind]));

// Aikar's G1 flags (https://docs.papermc.io/paper/aikars-flags), with the
// larger young generation recommended from 12 GB of heap.
function aikar(mb) {
  const big = mb >= 12 * 1024;
  return [
    '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC', '-XX:+AlwaysPreTouch', `-XX:G1NewSizePercent=${big ? 40 : 30}`, `-XX:G1MaxNewSizePercent=${big ? 50 : 40}`,
    `-XX:G1HeapRegionSize=${big ? 16 : 8}M`, `-XX:G1ReservePercent=${big ? 15 : 20}`, '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4',
    `-XX:InitiatingHeapOccupancyPercent=${big ? 20 : 15}`, '-XX:G1MixedGCLiveThresholdPercent=90', '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32', '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1', '-Dusing.aikars.flags=https://mcflags.emc.gs', '-Daikars.new.flags=true',
  ];
}
const FLAGS = { default: () => [], aikar };

const fail = (msg) => {
  throw new Error(msg);
};
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const str = (v, re) => typeof v === 'string' && re.test(v);

function checkLaunch(launch) {
  if (launch !== null && (!LAUNCH_TYPES.has(launch?.type) || !str(launch?.path, LAUNCH_PATH_RE) || launch.path.length > 255)) fail('Invalid launch target');
  return launch && { type: launch.type, path: launch.path };
}

// What ran before the last update, for rolling back.
function checkPrevious(p) {
  if (p == null) return null;
  if (!str(p.version, VERSION_RE)) fail('Invalid previous version');
  if (p.build != null && !int(p.build, 1, 1e9) && !str(p.build, LOADER_RE)) fail('Invalid previous build');
  if (!int(p.java, 8, 99)) fail('Invalid previous Java version');
  return { version: p.version, build: p.build ?? null, java: p.java, launch: checkLaunch(p.launch ?? null), snapshot: p.snapshot === true };
}

// Returns a normalized copy or throws naming the first bad field.
function validate(raw) {
  if (!raw || typeof raw !== 'object') fail('Invalid instance');
  const i = raw;
  if (!str(i.id, ID_RE)) fail('Invalid instance id (a-z, 0-9 and -, up to 32)');
  if (!DIST_IDS.has(i.distribution)) fail(`Unknown distribution ${i.distribution}`);
  if (!str(i.version, VERSION_RE)) fail('Invalid version');
  if (i.build != null && !int(i.build, 1, 1e9) && !str(i.build, LOADER_RE)) fail('Invalid build');
  if (!int(i.java, 8, 99)) fail('Invalid Java version');
  if (!int(i.memoryMb, 256, 1024 * 1024)) fail('Memory must be between 256 MB and 1 TB');
  if (!int(i.port, 1024, 65535)) fail('Invalid port (1024-65535)');
  if (!Object.hasOwn(FLAGS, String(i.flags ?? 'default'))) fail('Unknown JVM flags profile');
  const launch = checkLaunch(i.launch ?? null);
  const previous = checkPrevious(i.previous);
  const name = (typeof i.name === 'string' ? i.name : i.id).replace(/[\u0000-\u001f]/g, '').slice(0, 64) || i.id;
  return {
    id: i.id, name, distribution: i.distribution, kind: KIND[i.distribution], version: i.version, build: i.build ?? null,
    java: i.java, memoryMb: i.memoryMb, port: i.port, flags: i.flags ?? 'default', launch, previous, autostart: i.autostart === true,
    created: typeof i.created === 'string' ? i.created : null,
    eula: i.eula && typeof i.eula === 'object' ? { by: String(i.eula.by).slice(0, 64), at: String(i.eula.at).slice(0, 40) } : null,
  };
}

// argv for the launcher: java from javaHome, heap, flags, launch target.
function command(instance, javaHome) {
  const i = validate(instance);
  if (!i.launch) fail(`${i.id} is not installed yet`);
  const heap = [`-Xms${i.flags === 'aikar' ? i.memoryMb : Math.min(1024, i.memoryMb)}M`, `-Xmx${i.memoryMb}M`];
  const target = i.launch.type === 'jar' ? ['-jar', i.launch.path] : [`@${i.launch.path}`];
  // GC log: lib/heap.js reads how much of the heap is really in use.
  const gcLog = '-Xlog:gc:file=logs/gc.log:time:filecount=2,filesize=4M';
  return [path.join(javaHome, 'bin', 'java'), ...heap, ...FLAGS[i.flags](i.memoryMb), gcLog, ...target, ...(i.kind === 'proxy' ? [] : ['nogui'])];
}

// Reads <dir>/<id>/instance.json without following links; the id inside
// must match the folder.
function read(dir, id) {
  if (!str(id, ID_RE)) fail('Invalid instance id');
  // O_NOFOLLOW covers the file only; the folder must not be a link either.
  if (!fs.lstatSync(path.join(dir, id)).isDirectory()) fail(`${id} is not a folder`);
  const fd = fs.openSync(path.join(dir, id, 'instance.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let text;
  try {
    if (!fs.fstatSync(fd).isFile()) fail('instance.json is not a file');
    text = fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  const i = validate(JSON.parse(text));
  if (i.id !== id) fail(`instance.json in folder ${id} names ${i.id}`);
  return i;
}

// Valid instances; onError(name, err) hears about the ones that can't be read.
function list(dir, onError = () => {}) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => ID_RE.test(n)).sort();
  } catch (err) {
    if (err.code !== 'ENOENT') onError(null, err);
  }
  const out = [];
  for (const n of names) {
    try {
      out.push(read(dir, n));
    } catch (err) {
      onError(n, err);
    }
  }
  return out;
}

module.exports = { validate, command, read, list, ID_RE };

'use strict';

// Finds the world in an unpacked upload (lib/archive.js did the unpacking)
// and reads what its level.dat says.

const fs = require('fs');
const path = require('path');
const nbt = require('./nbt');

const httpError = (message) => Object.assign(new Error(message), { status: 400 });

// Formats are checked before gigabytes arrive; these say what to upload instead.
function explainNotWorld(head) {
  const b = Buffer.from(head);
  if (b[0] === 0x0a && b[1] === 0x00) return 'That looks like a single level.dat. Upload the whole world folder as a .zip.';
  return require('./archive').explainUnknown(b).replace('Not an archive. Upload a', 'Not a world archive. Upload the world folder packed as a').replace('Pack it as', 'Pack the world folder as');
}

// --- the world in it -----------------------------------------------------------------

const DIM_SUFFIX = /_(nether|the_end)$/;
const isFile = (p) => {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

// The world folder in an unpacked archive: the folder with level.dat, at
// the top or up to four levels down (a zip of a whole server folder works).
// Bukkit's <world>_nether and <world>_the_end next to it come along.
function locate(root) {
  const found = [];
  const queue = [['', 0]];
  while (queue.length) {
    const [rel, depth] = queue.shift();
    const dir = path.join(root, rel);
    if (isFile(path.join(dir, 'level.dat'))) found.push(rel);
    if (depth >= 4) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {}
    for (const e of entries) if (e.isDirectory()) queue.push([rel ? `${rel}/${e.name}` : e.name, depth + 1]);
  }
  // Worlds inside a world (an old copy in a subfolder) don't count, nor
  // Bukkit dimension folders, which have a level.dat of their own.
  const outer = found.filter((r) => !found.some((o) => o !== r && (o === '' || r.startsWith(`${o}/`))));
  const worlds = outer.filter((r) => !(DIM_SUFFIX.test(r) && outer.includes(r.replace(DIM_SUFFIX, ''))));
  if (!worlds.length) throw httpError('No world in the archive: it needs a world folder with a level.dat in it');
  if (worlds.length > 1) {
    const list = worlds.slice(0, 5).map((w) => w || '(top level)').join(', ');
    throw httpError(`The archive holds ${worlds.length} worlds (${list}${worlds.length > 5 ? ', …' : ''}); upload one at a time`);
  }
  const world = worlds[0];
  const dims = { '': world };
  if (world) for (const s of ['_nether', '_the_end']) if (isDir(path.join(root, world + s))) dims[s] = world + s;
  return { world, name: world ? path.basename(world) : null, dims, level: levelInfo(path.join(root, world, 'level.dat')) };
}

// What level.dat says about the world; refuses files that aren't one.
function levelInfo(file) {
  let data;
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > 32 * 1024 * 1024) throw new Error('too large');
    data = nbt.read(buf)?.Data;
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object') throw httpError('level.dat in the archive is not a Minecraft world file');
  const version = data.Version && typeof data.Version === 'object' ? data.Version : {};
  return {
    levelName: typeof data.LevelName === 'string' ? data.LevelName.slice(0, 100) : null,
    version: typeof version.Name === 'string' ? version.Name.slice(0, 40) : null,
    dataVersion: Number.isInteger(data.DataVersion) ? data.DataVersion : null,
  };
}

// "1.21.4" vs "26.1": newer, older or the same; null when either isn't a
// release number (snapshots).
function compareVersions(a, b) {
  const re = /^\d+(\.\d+)+$/;
  if (!re.test(String(a)) || !re.test(String(b))) return null;
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

module.exports = { locate, levelInfo, compareVersions, explainNotWorld };

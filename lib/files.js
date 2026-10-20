'use strict';

// The file manager: browsing and reading the shown server's folder for
// rconsole, and the path rules the helper re-checks before it changes
// anything. Paths are relative to the server folder ("" is the folder
// itself); nothing is ever followed through a link, and rconsole's own
// bookkeeping (instance.json, .rconsole-*) can't be changed from here.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_EDIT = 1024 * 1024; // text files up to this size open in the editor
const MAX_ENTRIES = 2000; // per folder listing
const MAX_DEPTH = 32;
// Where saving keeps the version it replaced, for Revert. Not the mod
// loader snapshot (.rconsole-previous at the top), nor configs' copies.
const PREVIOUS = '.rconsole-files-previous';
// server.properties keys rconsole relies on; a save keeps the current ones.
const RCON_KEYS = ['enable-rcon', 'rcon.port', 'rcon.password'];
// Text formats; anything else opens only when it looks like text.
const TEXT_EXT = new Set(['.yml', '.yaml', '.json', '.json5', '.properties', '.toml', '.conf', '.cfg', '.txt', '.md', '.log', '.ini', '.sh', '.csv', '.xml', '.mcmeta', '.js', '.lang', '.snbt', '.html', '.css', '.env', '.list', '.sk']);

const err = (status, message) => Object.assign(new Error(message), { status });

// "plugins/Essentials/config.yml" → its parts. Refuses anything that could
// leave the folder; `write` also refuses rconsole's own files.
function parts(rel, { write = false } = {}) {
  const s = String(rel ?? '');
  if (s.includes('\0') || s.includes('\\')) throw err(400, 'Invalid path');
  const p = s.split('/').filter((x) => x !== '');
  if (p.length > MAX_DEPTH) throw err(400, 'Path too deep');
  for (const x of p) {
    if (x === '.' || x === '..' || Buffer.byteLength(x) > 255 || /[\u0000-\u001f\u007f]/.test(x)) throw err(400, 'Invalid file name');
  }
  if (write) {
    if (!p.length) throw err(400, 'The server folder itself can\'t be changed');
    if (p.some((x) => x.startsWith('.rconsole'))) throw err(403, 'rconsole\'s own files can\'t be changed here');
    if (p.length === 1 && p[0] === 'instance.json') throw err(403, 'instance.json belongs to rconsole: change memory and ports under Servers → Settings');
  }
  return p;
}

// lstat of every component below root: real folders, the last of `kind`
// ('file', 'dir', 'any') unless missing and `missingOk`. Returns the full
// path and the last stat (null when missing).
function walk(root, p, { kind = 'any', missingOk = false } = {}) {
  let cur = root;
  let st = fs.lstatSync(root);
  if (!st.isDirectory()) throw err(500, 'The server folder is missing');
  for (const [i, x] of p.entries()) {
    cur = path.join(cur, x);
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      if (e.code === 'ENOENT' && missingOk && i === p.length - 1) return { full: cur, st: null };
      throw err(e.code === 'ENOENT' ? 404 : 500, e.code === 'ENOENT' ? `${p.slice(0, i + 1).join('/')} doesn't exist` : e.message);
    }
    const last = i === p.length - 1;
    if (st.isSymbolicLink()) throw err(400, `${p.slice(0, i + 1).join('/')} is a link; links aren't followed`);
    if (!last && !st.isDirectory()) throw err(400, `${p.slice(0, i + 1).join('/')} is not a folder`);
  }
  if (kind === 'file' && !st.isFile()) throw err(400, `${p.join('/') || 'This'} is not a file`);
  if (kind === 'dir' && !st.isDirectory()) throw err(400, `${p.join('/') || 'This'} is not a folder`);
  if (kind === 'any' && !st.isFile() && !st.isDirectory()) throw err(400, `${p.join('/')} is a special file`);
  return { full: cur, st };
}

const typeOf = (d) => (d.isDirectory() ? 'dir' : d.isFile() ? 'file' : d.isSymbolicLink() ? 'link' : 'other');
const isTextName = (name) => TEXT_EXT.has(path.extname(name).toLowerCase()) || /^(eula|ops|banned-.*|whitelist|usercache|server)\.(txt|json|properties)$/.test(name);
const looksText = (buf) => !buf.subarray(0, 8192).includes(0) && !/�/.test(buf.subarray(0, 8192).toString('utf8').slice(0, -4));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

class Files {
  constructor({ mcDir }) {
    this.mcDir = mcDir;
  }

  list(rel) {
    const p = parts(rel);
    const { full } = walk(this.mcDir, p, { kind: 'dir' });
    let all;
    try {
      all = fs.readdirSync(full, { withFileTypes: true });
    } catch (e) {
      throw err(e.code === 'EACCES' ? 403 : 500, e.code === 'EACCES' ? `rconsole can't read ${p.join('/') || 'the server folder'}` : e.message);
    }
    const visible = all.filter((d) => !d.name.startsWith('.rconsole'));
    const entries = visible.slice(0, MAX_ENTRIES).map((d) => {
      const type = typeOf(d);
      let size = null;
      let modified = null;
      try {
        const st = fs.lstatSync(path.join(full, d.name));
        size = type === 'file' ? st.size : null;
        modified = st.mtime.toISOString();
      } catch {}
      return { name: d.name, type, size, modified, editable: type === 'file' && size <= MAX_EDIT && isTextName(d.name) };
    });
    entries.sort((a, b) => (b.type === 'dir') - (a.type === 'dir') || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return { path: p.join('/'), entries, truncated: visible.length > MAX_ENTRIES };
  }

  // A file's contents when it is text and small enough, else what it is.
  read(rel) {
    const p = parts(rel);
    if (!p.length) throw err(400, 'Choose a file');
    const { full, st } = walk(this.mcDir, p, { kind: 'file' });
    const info = { path: p.join('/'), size: st.size, modified: st.mtime.toISOString(), hasPrevious: this.hasPrevious(p), protected: protectedReason(p) };
    if (st.size > MAX_EDIT) return { ...info, content: null, reason: 'large' };
    const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let buf;
    try {
      buf = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (!isTextName(p[p.length - 1]) && !looksText(buf)) return { ...info, content: null, reason: 'binary', sha256: sha256(buf) };
    return { ...info, content: buf.toString('utf8'), sha256: sha256(buf) };
  }

  hasPrevious(p) {
    try {
      return fs.lstatSync(path.join(this.mcDir, PREVIOUS, ...p)).isFile();
    } catch {
      return false;
    }
  }

  // For downloads: the checked full path and its stat.
  resolve(rel) {
    const p = parts(rel);
    return { parts: p, ...walk(this.mcDir, p) };
  }
}

// Why a file can't be saved from the editor, or null.
function protectedReason(p) {
  try {
    parts(p.join('/'), { write: true });
    return null;
  } catch (e) {
    return e.message;
  }
}

// The new server.properties text with rconsole's RCON settings as they are
// now, whatever the editor sent for them.
function keepRcon(next, current, properties) {
  const now = properties.toObject(properties.parse(current));
  const keep = Object.fromEntries(RCON_KEYS.filter((k) => now[k] !== undefined).map((k) => [k, now[k]]));
  return properties.stringify(properties.set(properties.parse(next), keep));
}

module.exports = { Files, parts, walk, keepRcon, sha256, isTextName, MAX_EDIT, PREVIOUS, RCON_KEYS };

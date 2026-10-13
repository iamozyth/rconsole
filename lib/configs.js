'use strict';

// Plugin and mod configuration files: listing and reading for rconsole, and
// the path rules the privileged helper re-checks before it writes. Only text
// formats under the config root (plugins/ on Bukkit-family servers, config/
// on Fabric, Quilt and Forge) and only plain files, never through links.

const fs = require('fs');
const path = require('path');
const platform = require('./platform');

const EXTENSIONS = ['.yml', '.yaml', '.json', '.json5', '.properties', '.toml', '.conf', '.cfg', '.txt'];
const MAX_BYTES = 512 * 1024;
const MAX_DEPTH = 5;
const MAX_FILES = 800;
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.+\- ]{0,99}$/;

const rootOf = (mcDir) => {
  const pf = platform.detect(mcDir);
  if (!pf.addons) return null;
  return pf.addons.dir === 'plugins' ? 'plugins' : 'config';
};

// Validates "plugins/Essentials/config.yml"-style paths; returns the parts.
function checkPath(rel, root) {
  const s = String(rel || '');
  if (!root) throw Object.assign(new Error('This server has no plugin or mod configs'), { status: 409 });
  const parts = s.split('/');
  if (parts[0] !== root || parts.length < 2 || parts.length > MAX_DEPTH + 1) throw Object.assign(new Error(`Config files live under ${root}/`), { status: 400 });
  for (const p of parts.slice(1)) if (!SEGMENT_RE.test(p) || p === '.rconsole-previous') throw Object.assign(new Error('Invalid file name'), { status: 400 });
  if (!EXTENSIONS.includes(path.extname(s).toLowerCase())) throw Object.assign(new Error(`Only ${EXTENSIONS.join(' ')} files can be edited`), { status: 400 });
  return parts;
}

// Every component must be a real directory (the last a regular file), not a
// link: nothing may point outside the server folder.
function noLinks(mcDir, parts, { lastMayBeMissing = false } = {}) {
  let p = mcDir;
  for (const [i, part] of parts.entries()) {
    p = path.join(p, part);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (err) {
      if (err.code === 'ENOENT' && lastMayBeMissing && i === parts.length - 1) return p;
      throw Object.assign(new Error(err.code === 'ENOENT' ? 'File not found' : err.message), { status: err.code === 'ENOENT' ? 404 : 500 });
    }
    const last = i === parts.length - 1;
    if (st.isSymbolicLink() || (last ? !st.isFile() : !st.isDirectory())) throw Object.assign(new Error('Links and special files are not editable'), { status: 400 });
    if (last && st.size > MAX_BYTES) throw Object.assign(new Error('File is too large to edit here (512 KB max)'), { status: 413 });
  }
  return p;
}

class Configs {
  constructor({ mcDir }) {
    this.mcDir = mcDir;
  }

  // Files grouped by plugin or mod folder (top-level files under "(root)").
  list() {
    const root = rootOf(this.mcDir);
    if (!root) return { root: null, groups: [] };
    const files = [];
    const walk = (rel, depth) => {
      if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
      let entries;
      try {
        entries = fs.readdirSync(path.join(this.mcDir, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!SEGMENT_RE.test(e.name) || e.name === '.rconsole-previous') continue;
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(r, depth + 1);
        else if (e.isFile() && EXTENSIONS.includes(path.extname(e.name).toLowerCase())) {
          const st = fs.statSync(path.join(this.mcDir, r));
          if (st.size <= MAX_BYTES) files.push({ path: r, size: st.size, modified: st.mtime.toISOString() });
        }
        if (files.length >= MAX_FILES) return;
      }
    };
    walk(root, 1);
    const groups = new Map();
    for (const f of files) {
      const g = f.path.split('/').length > 2 ? f.path.split('/')[1] : '(root)';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(f);
    }
    return { root, truncated: files.length >= MAX_FILES, groups: [...groups].map(([name, items]) => ({ name, files: items })) };
  }

  read(rel) {
    const root = rootOf(this.mcDir);
    const parts = checkPath(rel, root);
    const file = noLinks(this.mcDir, parts);
    const previous = path.join(this.mcDir, root, '.rconsole-previous', ...parts.slice(1));
    return {
      path: rel,
      content: fs.readFileSync(file, 'utf8'),
      modified: fs.statSync(file).mtime.toISOString(),
      hasPrevious: fs.existsSync(previous),
    };
  }
}

// Quick syntax checks before saving: JSON must parse; YAML must not indent
// with tabs (a common way to break a plugin config).
function validate(rel, content) {
  const ext = path.extname(rel).toLowerCase();
  if (Buffer.byteLength(content) > MAX_BYTES) return 'File is too large (512 KB max)';
  if (ext === '.json') {
    try {
      JSON.parse(content);
    } catch (err) {
      return `Invalid JSON: ${err.message}`;
    }
  }
  if (ext === '.yml' || ext === '.yaml') {
    const line = content.split('\n').findIndex((l) => /^ *\t/.test(l));
    if (line >= 0) return `YAML can't be indented with tabs (line ${line + 1})`;
  }
  return null;
}

module.exports = { Configs, checkPath, noLinks, validate, rootOf, EXTENSIONS, MAX_BYTES };

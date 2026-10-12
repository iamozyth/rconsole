'use strict';

// Plugin manager, rconsole side (read-only): list jars in MC_DIR/plugins,
// read their manifests, match them to Modrinth by sha512 and look for
// updates. Installing, updating, toggling, removing and rolling back run as
// helper jobs; every change applies at the next server start.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readEntry } = require('./zip');
const modrinth = require('./modrinth');

const FILE_RE = /^[A-Za-z0-9._+ ()-]{1,120}\.jar(\.disabled)?$/;
const CACHE_MS = 10 * 60 * 1000;

// Top-level scalars and simple lists from plugin.yml; nothing more is needed.
function parseManifest(text) {
  const out = {};
  let listKey = null;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      out[listKey].push(unquote(item[1]));
      continue;
    }
    const m = raw.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!m) {
      if (!/^\s/.test(raw)) listKey = null;
      continue;
    }
    const [, key, value] = m;
    listKey = null;
    if (value === '') {
      out[key] = [];
      listKey = key;
    } else if (/^\[.*\]$/.test(value)) out[key] = value.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter(Boolean);
    else out[key] = unquote(value);
  }
  return out;
}

// Mod metadata: Fabric (fabric.mod.json), Quilt (quilt.mod.json) and
// Forge/NeoForge (META-INF/[neoforge.]mods.toml, version often taken from
// the jar manifest). Returns the same shape as plugin.yml.
function parseModManifest(buf) {
  const json = (name) => {
    const e = readEntry(buf, name);
    if (!e) return null;
    try {
      return JSON.parse(e.toString('utf8'));
    } catch {
      return null;
    }
  };
  const names = (list) => [].concat(list || []).map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean);
  const fabric = json('fabric.mod.json');
  if (fabric) return { name: fabric.name || fabric.id, version: fabric.version, description: fabric.description, authors: names(fabric.authors), website: fabric.contact?.homepage };
  const quilt = json('quilt.mod.json')?.quilt_loader;
  if (quilt) return { name: quilt.metadata?.name || quilt.id, version: quilt.version, description: quilt.metadata?.description, authors: Object.keys(quilt.metadata?.contributors || {}) };
  const toml = readEntry(buf, 'META-INF/neoforge.mods.toml') || readEntry(buf, 'META-INF/mods.toml');
  if (toml) {
    const block = toml.toString('utf8').split(/^\s*\[\[mods\]\]\s*$/m)[1] || '';
    const field = (k) => block.match(new RegExp(`^\\s*${k}\\s*=\\s*(?:'''([\\s\\S]*?)'''|"([^"]*)"|'([^']*)')`, 'm'))?.slice(1).find((x) => x !== undefined)?.trim();
    let version = field('version');
    if (!version || version.includes('${')) version = readEntry(buf, 'META-INF/MANIFEST.MF')?.toString('utf8').match(/^Implementation-Version:\s*(\S+)/m)?.[1];
    return { name: field('displayName') || field('modId'), version, description: field('description'), authors: field('authors') ? [field('authors')] : [] };
  }
  return null;
}

function unquote(s) {
  s = s.replace(/\s+#.*$/, '').trim();
  return /^(['"]).*\1$/.test(s) ? s.slice(1, -1) : s;
}

class Plugins {
  constructor({ mcDir, jobs, pending, log, gameVersion, platform }) {
    Object.assign(this, { mcDir, jobs, pending, log, gameVersion, platform });
    this.hashes = new Map(); // file -> { key, sha512 }
    this.remote = { at: 0, key: '', value: null };
  }

  // plugins/ or mods/, from the detected platform; null on vanilla.
  get addons() {
    return this.platform().addons;
  }

  get dir() {
    return this.addons ? path.join(this.mcDir, this.addons.dir) : null;
  }

  checkFile(file) {
    if (!FILE_RE.test(file) || path.basename(file) !== file) throw Object.assign(new Error('Invalid plugin file name'), { status: 400 });
    return file;
  }

  previousIndex() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, '.rconsole-previous', 'index.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  async local() {
    if (!this.addons) return [];
    let names;
    try {
      names = await fs.promises.readdir(this.dir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const previous = this.previousIndex();
    const list = [];
    for (const file of names.filter((n) => FILE_RE.test(n))) {
      const full = path.join(this.dir, file);
      const stat = await fs.promises.stat(full).catch(() => null);
      if (!stat?.isFile()) continue;
      let buf = null;
      let manifest = {};
      let error = null;
      try {
        buf = await fs.promises.readFile(full);
        if (this.addons.kind === 'mod') manifest = parseModManifest(buf) || {};
        else {
          const yml = readEntry(buf, 'paper-plugin.yml') || readEntry(buf, 'plugin.yml');
          manifest = yml ? parseManifest(yml.toString('utf8')) : {};
        }
      } catch (err) {
        error = err.code === 'EACCES' ? 'Not readable by rconsole (check group permissions)' : err.message;
      }
      const key = `${stat.size}:${stat.mtimeMs}`;
      let sha512 = this.hashes.get(file)?.key === key ? this.hashes.get(file).sha512 : null;
      if (!sha512 && buf) {
        sha512 = crypto.createHash('sha512').update(buf).digest('hex');
        this.hashes.set(file, { key, sha512 });
      }
      const authors = [].concat(manifest.authors || [], manifest.author || []).filter(Boolean);
      list.push({
        file,
        enabled: !file.endsWith('.disabled'),
        name: manifest.name || file.replace(/\.jar(\.disabled)?$/, ''),
        version: manifest.version || null,
        description: manifest.description || null,
        authors,
        website: manifest.website || null,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        sha512,
        canRollback: Boolean(previous[file]),
        error,
      });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  async list({ refresh = false } = {}) {
    const plugins = await this.local();
    const gameVersion = await this.gameVersion();
    const hashes = plugins.map((p) => p.sha512).filter(Boolean);
    const key = `${gameVersion}|${hashes.join(',')}`;
    let remoteError = null;
    if (refresh || this.remote.key !== key || Date.now() - this.remote.at > CACHE_MS) {
      try {
        const [known, latest] = await Promise.all([modrinth.versionsByHash(hashes), modrinth.latestByHash(hashes, gameVersion, this.platform().loaders)]);
        const ids = [...new Set(Object.values(known).map((v) => v.project_id))];
        const projects = Object.fromEntries((await modrinth.projects(ids)).map((p) => [p.id, p]));
        this.remote = { at: Date.now(), key, value: { known, latest, projects } };
      } catch (err) {
        remoteError = err.message;
      }
    }
    const remote = this.remote.key === key ? this.remote.value : null;
    for (const p of plugins) {
      const v = remote?.known[p.sha512];
      const project = v && remote.projects[v.project_id];
      p.modrinth = v ? { projectId: v.project_id, versionId: v.id, version: v.version_number, slug: project?.slug, title: project?.title, icon: project?.icon_url || null } : null;
      const next = remote?.latest[p.sha512];
      p.update = v && next && next.id !== v.id && Date.parse(next.date_published) > Date.parse(v.date_published)
        ? { versionId: next.id, version: next.version_number, published: next.date_published, type: next.version_type }
        : null;
    }
    const pf = this.platform();
    return { gameVersion, plugins, remoteError, pending: await this.pending.list(), platform: { id: pf.id, name: pf.name }, addons: this.addons };
  }

  noAddons() {
    if (!this.addons) throw Object.assign(new Error(`${this.platform().name} loads no plugins or mods; data packs go in the world's datapacks folder`), { status: 409 });
  }

  async search(query) {
    this.noAddons();
    if (!String(query || '').trim()) return [];
    const installed = new Set((await this.list()).plugins.map((p) => p.modrinth?.projectId).filter(Boolean));
    return (await modrinth.search(query, await this.gameVersion(), { loaders: this.platform().loaders, projectType: this.addons.projectType })).map((h) => ({ ...h, installed: installed.has(h.id) }));
  }

  async install(projectId, user) {
    this.noAddons();
    const v = await modrinth.bestVersion(String(projectId), await this.gameVersion(), this.platform().loaders);
    if (!v) throw Object.assign(new Error('No version of this plugin supports this server'), { status: 409 });
    const r = await this.jobs.run('plugin-install', { versionId: v.id });
    this.pending.add(`install ${r.file}`);
    this.log(`plugins: ${user} installed ${r.file}`);
    return r;
  }

  async update(file, user) {
    this.checkFile(file);
    const p = (await this.list({ refresh: true })).plugins.find((x) => x.file === file);
    if (!p?.update) throw Object.assign(new Error('No update available for this plugin'), { status: 409 });
    const r = await this.jobs.run('plugin-install', { versionId: p.update.versionId, replace: file });
    this.pending.add(`update ${p.name} to ${p.update.version}`);
    this.log(`plugins: ${user} updated ${file} -> ${r.file}`);
    return r;
  }

  async change(kind, file, args, user) {
    this.checkFile(file);
    const r = await this.jobs.run(kind, { file, ...args });
    const verb = { 'plugin-toggle': args.enabled ? 'enable' : 'disable', 'plugin-rollback': 'roll back', 'plugin-remove': 'remove' }[kind] || kind;
    this.pending.add(`${verb} ${file.replace(/\.disabled$/, '')}`);
    this.log(`plugins: ${user} ${kind} ${file}`);
    return r;
  }
}

module.exports = { Plugins, parseManifest, parseModManifest, FILE_RE };

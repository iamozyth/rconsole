'use strict';

// Resumable uploads of archives: the browser sends the file in chunks (PUT
// with the offset it continues from), so a dropped connection resumes where
// it stopped and no proxy sees one huge request. Uploads live in
// BACKUP_DIR/.uploads, readable by the helper through the backup group; the
// helper unpacks them (lib/archive.js). Unfinished uploads are removed after
// a day. Nothing here is about worlds: `explain` words the error for a file
// that isn't an archive.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline, Transform } = require('stream');
const { detect, explainUnknown } = require('./archive');

const ID_RE = /^[a-f0-9]{32}$/;
const CHUNK = 16 * 1024 * 1024; // what the browser sends per request
const MAX_CHUNK = 64 * 1024 * 1024;
const KEEP_FREE = 1024 ** 3;
const MAX_OPEN = 4;
const DAY = 86400 * 1000;
const httpError = (status, message, extra) => Object.assign(new Error(message), { status, extra });

class Uploads {
  constructor({ backupDir, log = () => {}, explain = explainUnknown }) {
    this.backupDir = backupDir;
    this.dir = path.join(backupDir, '.uploads');
    this.log = log;
    this.explain = explain;
    this.writing = new Set();
  }

  // Same ownership dance as job requests (lib/jobs.js): rconsole runs with
  // UMask=0077, the helper reads through the group that owns BACKUP_DIR.
  ensureDir() {
    const gid = fs.statSync(this.backupDir).gid;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.chownSync(this.dir, -1, gid);
    fs.chmodSync(this.dir, 0o750);
    return gid;
  }

  paths(id) {
    if (!ID_RE.test(String(id))) throw httpError(404, 'Upload not found');
    return { part: path.join(this.dir, `${id}.part`), meta: path.join(this.dir, `${id}.json`) };
  }

  meta(id) {
    try {
      return JSON.parse(fs.readFileSync(this.paths(id).meta, 'utf8'));
    } catch (err) {
      if (err.status) throw err;
      throw httpError(404, 'Upload not found (unfinished uploads are removed after a day)');
    }
  }

  status(id) {
    const m = this.meta(id);
    let received = 0;
    try {
      received = fs.statSync(this.paths(id).part).size;
    } catch {}
    return { id, name: m.name, size: m.size, received, complete: received === m.size, chunkSize: CHUNK };
  }

  free() {
    try {
      const s = fs.statfsSync(this.backupDir);
      return s.bavail * s.bsize;
    } catch {
      return Infinity;
    }
  }

  create({ name, size, user }) {
    size = Number(size);
    if (!Number.isSafeInteger(size) || size < 1) throw httpError(400, 'That file is empty');
    name = String(name || 'world').replace(/[\0-\x1f]/g, '').slice(0, 200);
    this.prune();
    const open = this.list();
    if (open.length >= MAX_OPEN) throw httpError(409, `${open.length} uploads are already in progress; finish or cancel one first`);
    const free = this.free();
    if (size + KEEP_FREE > free) throw httpError(507, `Not enough disk space for this upload: ${gb(size)} needed, ${gb(Math.max(0, free - KEEP_FREE))} free on the backup disk`);
    const gid = this.ensureDir();
    const id = crypto.randomBytes(16).toString('hex');
    const p = this.paths(id);
    fs.writeFileSync(p.meta, JSON.stringify({ name, size, user, created: new Date().toISOString() }), { mode: 0o600 });
    fs.writeFileSync(p.part, '', { mode: 0o600, flag: 'wx' });
    fs.chownSync(p.part, -1, gid);
    fs.chmodSync(p.part, 0o640);
    this.log(`uploads: ${user} started uploading ${name} (${gb(size)})`);
    return this.status(id);
  }

  // Appends the request body at `offset`, which must be where the upload
  // stands. Resolves with the new status.
  async append(id, offset, req, user) {
    const m = this.meta(id);
    if (m.user !== user) throw httpError(403, 'This upload belongs to someone else');
    if (this.writing.has(id)) throw httpError(409, 'This upload is already receiving data');
    const { part } = this.paths(id);
    const received = fs.statSync(part).size;
    if (Number(offset) !== received) throw httpError(409, `The upload continues at byte ${received}`, { received });
    const length = Number(req.headers['content-length']);
    if (Number.isFinite(length) && (length > MAX_CHUNK || received + length > m.size)) throw httpError(413, 'Chunk too large');
    this.writing.add(id);
    try {
      let bytes = 0;
      const limit = Math.min(MAX_CHUNK, m.size - received);
      const counter = new Transform({
        transform(chunk, enc, cb) {
          bytes += chunk.length;
          cb(bytes > limit ? httpError(413, 'Chunk too large') : null, chunk);
        },
      });
      await new Promise((resolve, reject) => pipeline(req, counter, fs.createWriteStream(part, { flags: 'a' }), (err) => (err ? reject(err) : resolve())));
    } catch (err) {
      // What arrived stays; the browser asks where to continue.
      if (err.status) throw err;
      throw httpError(400, `Upload interrupted: ${err.message}`);
    } finally {
      this.writing.delete(id);
    }
    fs.utimesSync(this.paths(id).meta, new Date(), new Date()); // last activity, for prune()
    const st = this.status(id);
    if (received === 0 && st.received > 0) {
      // Checked as soon as the start is here, not after gigabytes.
      const head = Buffer.alloc(512);
      const fd = fs.openSync(part, 'r');
      const n = fs.readSync(fd, head, 0, 512, 0);
      fs.closeSync(fd);
      if (!detect(head.subarray(0, n)) && (n >= 512 || st.complete)) {
        this.remove(id);
        throw httpError(415, this.explain(head.subarray(0, n)));
      }
    }
    return st;
  }

  list() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir);
    } catch {}
    return files.filter((f) => /^[a-f0-9]{32}\.json$/.test(f)).map((f) => f.slice(0, 32));
  }

  remove(id) {
    const p = this.paths(id);
    fs.rmSync(p.part, { force: true });
    fs.rmSync(p.meta, { force: true });
  }

  // Unfinished or unused uploads older than a day; also parts whose
  // metadata is gone.
  prune(now = Date.now()) {
    let files = [];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const f of files) {
      const m = /^([a-f0-9]{32})\.(json|part)$/.exec(f);
      if (!m || this.writing.has(m[1])) continue;
      const st = fs.statSync(path.join(this.dir, f), { throwIfNoEntry: false });
      const orphan = m[2] === 'part' && !files.includes(`${m[1]}.json`);
      if (st && (orphan || now - st.mtimeMs > DAY)) {
        this.remove(m[1]);
        this.log(`uploads: removed the unfinished upload ${m[1]}`);
      }
    }
  }
}

const gb = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.ceil(n / 1024 ** 2)} MB`);

module.exports = { Uploads, CHUNK };

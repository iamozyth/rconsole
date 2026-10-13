'use strict';

// Offsite copies of backups in any S3-compatible bucket, optionally
// encrypted on this machine before upload. Uploads run one at a time in the
// background (after every backup when enabled), with retries; old remote
// copies are pruned per world. Downloads land in the backup folder, from
// where the usual restore takes over.

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { S3 } = require('./s3');
const { encryptStream, decryptStream } = require('./crypt');
const names = require('./names');

const SECRET = '••••••••';
const RETRY_MS = [60e3, 5 * 60e3, 30 * 60e3];

class Offsite {
  constructor({ stateDir, backupDir, log = () => {}, onResult = () => {}, env = process.env }) {
    Object.assign(this, { backupDir, log, onResult });
    this.file = path.join(stateDir, 'offsite.json');
    this.config = this.load(env);
    this.queue = [];
    this.state = { running: null, progress: null, last: null, error: null };
    this.busy = false;
  }

  load(env) {
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {}
    return {
      endpoint: env.OFFSITE_ENDPOINT || saved.endpoint || '',
      region: env.OFFSITE_REGION || saved.region || 'us-east-1',
      bucket: env.OFFSITE_BUCKET || saved.bucket || '',
      prefix: (saved.prefix ?? 'rconsole/').replace(/^\/+/, ''),
      accessKeyId: env.OFFSITE_ACCESS_KEY_ID || saved.accessKeyId || '',
      secretAccessKey: env.OFFSITE_SECRET_ACCESS_KEY || saved.secretAccessKey || '',
      passphrase: env.OFFSITE_PASSPHRASE || saved.passphrase || '',
      pathStyle: saved.pathStyle !== false,
      auto: Boolean(saved.auto),
      keep: Number.isInteger(saved.keep) ? saved.keep : 14,
      last: saved.last || null,
    };
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get configured() {
    const c = this.config;
    return Boolean(c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey);
  }

  // Settings for the UI: secrets are never sent back, only whether they're set.
  view() {
    const c = this.config;
    return {
      endpoint: c.endpoint, region: c.region, bucket: c.bucket, prefix: c.prefix, accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey ? SECRET : '', passphrase: c.passphrase ? SECRET : '',
      encrypted: Boolean(c.passphrase), pathStyle: c.pathStyle, auto: c.auto, keep: c.keep,
      configured: this.configured, state: { ...this.state, queued: this.queue.length }, last: c.last,
    };
  }

  update(input) {
    const c = { ...this.config };
    for (const k of ['endpoint', 'region', 'bucket', 'accessKeyId']) if (typeof input[k] === 'string') c[k] = input[k].trim().slice(0, 300);
    if (typeof input.prefix === 'string') c.prefix = input.prefix.trim().replace(/^\/+/, '').slice(0, 200);
    if (c.prefix && !c.prefix.endsWith('/')) c.prefix += '/';
    for (const k of ['secretAccessKey', 'passphrase']) if (typeof input[k] === 'string' && input[k] !== SECRET) c[k] = input[k].slice(0, 300);
    if (typeof input.pathStyle === 'boolean') c.pathStyle = input.pathStyle;
    if (typeof input.auto === 'boolean') c.auto = input.auto;
    if (Number.isInteger(input.keep) && input.keep >= 0 && input.keep <= 1000) c.keep = input.keep;
    if (c.endpoint) {
      try {
        if (!/^https?:$/.test(new URL(c.endpoint).protocol)) throw new Error();
      } catch {
        throw Object.assign(new Error('Endpoint must be an http(s) URL, e.g. https://s3.eu-central-003.backblazeb2.com'), { status: 400 });
      }
    }
    if (c.bucket && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(c.bucket)) throw Object.assign(new Error('Invalid bucket name'), { status: 400 });
    this.config = c;
    this.save();
    return this.view();
  }

  client() {
    if (!this.configured) throw Object.assign(new Error('Offsite storage is not set up'), { status: 409 });
    const c = this.config;
    return new S3({ endpoint: c.endpoint, region: c.region, bucket: c.bucket, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, pathStyle: c.pathStyle });
  }

  async test() {
    const items = await this.client().list(this.config.prefix);
    return { ok: true, objects: items.length };
  }

  // Remote copies, newest first. Encrypted ones end in ".enc".
  async list() {
    const prefix = this.config.prefix;
    const items = await this.client().list(prefix);
    return items
      .map((o) => {
        const name = o.key.slice(prefix.length);
        const file = name.replace(/\.enc$/, '');
        const parsed = names.parseBackupName(file);
        return parsed ? { name, file, world: parsed.world, size: o.size, modified: o.modified, encrypted: name.endsWith('.enc') } : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a.file < b.file ? 1 : -1));
  }

  // Queues a backup file for upload; returns at once.
  enqueue(file, { reason = 'manual' } = {}) {
    if (!names.parseBackupName(file)) throw Object.assign(new Error('Invalid backup name'), { status: 400 });
    if (!this.configured) throw Object.assign(new Error('Offsite storage is not set up'), { status: 409 });
    if (!this.queue.some((q) => q.file === file) && this.state.running !== file) this.queue.push({ file, reason, attempt: 0 });
    this.pump();
    return this.view();
  }

  // Called after every successful local backup.
  onBackup(file) {
    if (this.config.auto && this.configured) this.enqueue(file, { reason: 'auto' });
  }

  async pump() {
    if (this.busy) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    this.state = { ...this.state, running: job.file, progress: 0, error: null };
    try {
      const result = await this.uploadNow(job.file);
      this.config.last = { file: job.file, at: new Date().toISOString(), size: result.size, encrypted: result.encrypted };
      this.save();
      this.state.last = this.config.last;
      this.log(`offsite: uploaded ${job.file}${result.encrypted ? ' (encrypted)' : ''}`);
      await this.prune(names.parseBackupName(job.file).world).catch((err) => this.log(`offsite: pruning failed: ${err.message}`));
      this.onResult({ ok: true, file: job.file });
    } catch (err) {
      this.log(`offsite: upload of ${job.file} failed: ${err.message}`);
      this.state.error = `${job.file}: ${err.message}`;
      if (job.attempt < RETRY_MS.length) {
        const delay = RETRY_MS[job.attempt];
        setTimeout(() => {
          this.queue.push({ ...job, attempt: job.attempt + 1 });
          this.pump();
        }, delay).unref?.();
      } else {
        this.onResult({ ok: false, file: job.file, error: err.message });
      }
    } finally {
      this.busy = false;
      this.state.running = null;
      this.state.progress = null;
      this.pump();
    }
  }

  async uploadNow(file) {
    const local = path.join(this.backupDir, file);
    const stat = await fs.promises.stat(local);
    const encrypted = Boolean(this.config.passphrase);
    const key = `${this.config.prefix}${file}${encrypted ? '.enc' : ''}`;
    const input = fs.createReadStream(local);
    const source = encrypted ? input.pipe(encryptStream(this.config.passphrase)) : input;
    input.on('error', (err) => source.destroy(err));
    const r = await this.client().upload(key, source, { onProgress: (n) => (this.state.progress = Math.min(1, n / stat.size)) });
    return { ...r, encrypted };
  }

  // Keeps the newest `keep` copies of a world (0 keeps all).
  async prune(world) {
    if (!this.config.keep) return;
    const mine = (await this.list()).filter((x) => x.world === world);
    for (const x of mine.slice(this.config.keep)) {
      await this.client().remove(`${this.config.prefix}${x.name}`);
      this.log(`offsite: pruned ${x.name}`);
    }
  }

  async remove(name) {
    if (!names.parseBackupName(String(name).replace(/\.enc$/, ''))) throw Object.assign(new Error('Invalid backup name'), { status: 400 });
    await this.client().remove(`${this.config.prefix}${name}`);
    return { ok: true };
  }

  // Downloads (and decrypts) a remote copy into the backup folder.
  async download(name) {
    const file = String(name).replace(/\.enc$/, '');
    if (!names.parseBackupName(file)) throw Object.assign(new Error('Invalid backup name'), { status: 400 });
    const target = path.join(this.backupDir, file);
    if (fs.existsSync(target)) throw Object.assign(new Error(`${file} is already in the backup folder`), { status: 409 });
    const encrypted = name.endsWith('.enc');
    if (encrypted && !this.config.passphrase) throw Object.assign(new Error('This copy is encrypted; enter the passphrase first'), { status: 409 });
    const tmp = path.join(this.backupDir, `.offsite-${process.pid}-${Date.now()}.part`);
    const res = await this.client().download(`${this.config.prefix}${name}`);
    try {
      const steps = [res, ...(encrypted ? [decryptStream(this.config.passphrase)] : []), fs.createWriteStream(tmp, { flags: 'wx', mode: 0o640 })];
      await pipeline(...steps);
      fs.chmodSync(tmp, 0o640); // the restore runs as the Minecraft user, through the group
      fs.linkSync(tmp, target); // fails instead of replacing if the name appeared meanwhile
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    this.log(`offsite: downloaded ${file}`);
    return { file };
  }
}

module.exports = { Offsite, SECRET };

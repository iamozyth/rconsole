'use strict';

// Unpacks an uploaded archive (.zip, .tar, .tar.gz, .tar.zst, .tar.xz,
// .tar.bz2) into a folder. Runs in the helper, as the Minecraft user, and
// knows nothing about worlds (lib/worldimport.js finds the world in what it
// unpacked). The archive comes from a browser, so nothing in it is trusted:
// entries are written by this code, never by tar or unzip, and only plain
// files and folders are accepted. Every path is checked (no absolute paths,
// no "..", no links), modes are set here (folders 0750, files 0640, so the
// minecraft group can read them), and a byte budget stops archives that
// unpack to more than the disk has free.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const stream = require('stream');
const { spawn } = require('child_process');

const httpError = (message) => Object.assign(new Error(message), { status: 400 });
const MAX_ENTRIES = 1000000; // a big world has ~100k files
const MAX_DEPTH = 32;

// Archive format from its first bytes; the file name doesn't matter.
function detect(head) {
  const b = Buffer.from(head);
  if (b.length >= 4 && b.readUInt32LE(0) === 0x04034b50) return 'zip';
  if (b.length >= 4 && b.readUInt32LE(0) === 0x06054b50) return 'zip'; // empty zip
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  if (b.length >= 4 && b.readUInt32LE(0) === 0xfd2fb528) return 'zstd';
  if (b.length >= 6 && b.subarray(0, 6).equals(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))) return 'xz';
  if (b.length >= 3 && b.toString('latin1', 0, 3) === 'BZh') return 'bzip2';
  if (b.length >= 262 && b.toString('latin1', 257, 262) === 'ustar') return 'tar';
  return null;
}

// What people upload instead, with what to do about it.
function explainUnknown(head) {
  const b = Buffer.from(head);
  if (b.toString('latin1', 0, 6) === '7z\xbc\xaf\x27\x1c') return '7-Zip archives aren\'t supported. Pack it as a .zip instead.';
  if (b.toString('latin1', 0, 4) === 'Rar!') return 'RAR archives aren\'t supported. Pack it as a .zip instead.';
  return 'Not an archive. Upload a .zip, .tar.gz, .tar.zst or .tar.xz.';
}

// --- paths ------------------------------------------------------------------------

const JUNK = (parts) => parts[0] === '__MACOSX' || parts.some((p) => p.startsWith('._')) || ['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(parts[parts.length - 1]);

// An entry name as path parts. Backslashes count as separators (zips made
// on Windows); anything that could leave the folder it is unpacked into
// refuses the whole archive.
function entryParts(raw) {
  const name = String(raw).replace(/\\/g, '/');
  if (name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw httpError(`The archive contains an unsafe path (${JSON.stringify(name.slice(0, 120))}); refusing it`);
  const parts = name.split('/').filter((p) => p && p !== '.');
  if (parts.includes('..')) throw httpError(`The archive contains an unsafe path (${JSON.stringify(name.slice(0, 120))}); refusing it`);
  if (parts.length > MAX_DEPTH || parts.some((p) => Buffer.byteLength(p) > 255)) throw httpError(`The archive contains a path that is too long (${JSON.stringify(name.slice(0, 120))})`);
  return parts;
}

// --- writing ----------------------------------------------------------------------

const O_FILE = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;

// Writes entries below `root`, a fresh folder only the helper can write to:
// no link can exist in it, since nothing here ever creates one.
class Writer {
  constructor(root, { maxBytes, maxEntries = MAX_ENTRIES }) {
    Object.assign(this, { root, maxBytes, maxEntries });
    this.bytes = 0;
    this.entries = 0;
    this.files = 0;
    this.made = new Set();
  }

  count() {
    if (++this.entries > this.maxEntries) throw httpError(`The archive has more than ${this.maxEntries.toLocaleString('en')} entries`);
  }

  dir(parts) {
    let p = this.root;
    for (let i = 0; i < parts.length; i++) {
      p = path.join(p, parts[i]);
      const key = parts.slice(0, i + 1).join('/');
      if (this.made.has(key)) continue;
      try {
        fs.mkdirSync(p, { mode: 0o750 });
        fs.chmodSync(p, 0o750);
      } catch (err) {
        if (err.code !== 'EEXIST' || !fs.lstatSync(p).isDirectory()) throw httpError(`The archive has both a file and a folder named ${key}`);
      }
      this.made.add(key);
    }
  }

  // Streams `source` (an async iterable of buffers) into the file `parts`.
  // Returns the CRC-32 when asked for (zip entries carry one).
  async file(parts, source, { crc = false } = {}) {
    this.count();
    this.dir(parts.slice(0, -1));
    const file = path.join(this.root, ...parts);
    let fd;
    try {
      fd = fs.openSync(file, O_FILE, 0o640);
    } catch (err) {
      throw httpError(err.code === 'EISDIR' ? `The archive has both a file and a folder named ${parts.join('/')}` : `Can't write ${parts.join('/')}: ${err.message}`);
    }
    let sum = crc ? 0 : null;
    let size = 0;
    try {
      fs.fchmodSync(fd, 0o640);
      for await (const chunk of source) {
        size += chunk.length;
        this.bytes += chunk.length;
        if (this.bytes > this.maxBytes) throw Object.assign(httpError(`The archive unpacks to more than the free disk space allows (over ${gib(this.maxBytes)} unpacked)`), { budget: true });
        if (crc) sum = crc32(chunk, sum);
        let off = 0;
        while (off < chunk.length) off += fs.writeSync(fd, chunk, off, chunk.length - off);
      }
    } finally {
      fs.closeSync(fd);
    }
    this.files++;
    return { size, crc: sum };
  }
}

const gib = (n) => `${(n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 1 : 0)} GB`;

// zlib.crc32 arrived in Node 22.2; older ones use the table.
let TABLE;
function crc32(buf, prev = 0) {
  if (zlib.crc32) return zlib.crc32(buf, prev);
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c;
    }
  }
  let c = ~prev;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// --- tar ---------------------------------------------------------------------------

// Reads exact byte counts from a stream of chunks.
class Reader {
  constructor(source, limit) {
    this.it = source[Symbol.asyncIterator]();
    this.buf = Buffer.alloc(0);
    this.done = false;
    this.consumed = 0;
    this.limit = limit;
  }

  async next() {
    const { value, done } = await this.it.next();
    if (done) {
      this.done = true;
      return null;
    }
    this.consumed += value.length;
    if (this.consumed > this.limit) throw httpError('The archive unpacks to more than the free disk space allows');
    return value;
  }

  async fill(n) {
    while (this.buf.length < n && !this.done) {
      const c = await this.next();
      if (c) this.buf = this.buf.length ? Buffer.concat([this.buf, c]) : c;
    }
    return this.buf.length >= n;
  }

  async read(n) {
    if (!(await this.fill(n))) throw httpError('The archive ends early; the upload may be incomplete');
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  // Yields the next n bytes as they arrive.
  async *take(n) {
    while (n > 0) {
      if (!this.buf.length) {
        const c = this.done ? null : await this.next();
        if (!c) throw httpError('The archive ends early; the upload may be incomplete');
        this.buf = c;
      }
      const part = this.buf.subarray(0, Math.min(n, this.buf.length));
      this.buf = this.buf.subarray(part.length);
      n -= part.length;
      yield part;
    }
  }

  async skip(n) {
    for await (const part of this.take(n)) void part;
  }
}

function tarNumber(h, off, len) {
  if (h[off] & 0x80) {
    // base-256 (GNU, for sizes over 8 GB)
    let n = 0;
    for (let i = off + 1; i < off + len; i++) n = n * 256 + h[i];
    return n;
  }
  const s = h.toString('latin1', off, off + len).replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) : 0;
}

const tarString = (h, off, len) => {
  const s = h.subarray(off, off + len);
  const end = s.indexOf(0);
  return s.toString('utf8', 0, end < 0 ? len : end);
};

function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(buf.toString('latin1', i, sp), 10);
    if (!(len > 0) || i + len > buf.length) break;
    const rec = buf.toString('utf8', sp + 1, i + len - 1);
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

const pad = (n) => (512 - (n % 512)) % 512;

async function extractTar(source, writer, limit) {
  const r = new Reader(source, limit);
  let longName = null;
  let pax = {};
  for (;;) {
    if (!(await r.fill(512))) {
      if (r.buf.length) throw httpError('The archive ends early; the upload may be incomplete');
      break; // some writers leave out the two zero blocks
    }
    const h = await r.read(512);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== tarNumber(h, 148, 8)) throw httpError(writer.entries ? 'The archive is damaged (bad tar header); try uploading it again' : 'Not a tar archive');
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    let size = tarNumber(h, 124, 12);
    if (pax.size !== undefined) size = Number(pax.size);
    if (!Number.isSafeInteger(size) || size < 0) throw httpError('The archive is damaged (bad entry size)');
    let name = tarString(h, 0, 100);
    if (h.toString('latin1', 257, 262) === 'ustar') {
      const prefix = tarString(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    if (longName !== null) name = longName;
    if (pax.path !== undefined) name = pax.path;

    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      if (size > 1024 * 1024) throw httpError('The archive is damaged (oversized header)');
      const data = Buffer.from(await r.read(size));
      await r.skip(pad(size));
      if (type === 'x') pax = parsePax(data);
      else if (type === 'L') longName = tarString(data, 0, data.length);
      continue; // global headers and long link names don't matter for files
    }
    const parts = entryParts(name);
    longName = null;
    pax = {};
    if (type === '1' || type === '2') throw httpError(`The archive contains links (${parts.join('/')}); refusing it`);
    if (type !== '0' && type !== '7' && type !== '5') throw httpError(`The archive contains special files (${parts.join('/')}); refusing it`);
    if (type === '5') {
      await r.skip(size + pad(size));
      if (parts.length && !JUNK(parts)) {
        writer.count();
        writer.dir(parts);
      }
      continue;
    }
    if (!parts.length || JUNK(parts)) await r.skip(size);
    else await writer.file(parts, r.take(size));
    await r.skip(pad(size));
  }
  // Read to the end (record padding), so a decompressor can finish.
  while (await r.next());
}

// --- zip ---------------------------------------------------------------------------

// Bytes start..end (exclusive) of the open file. Not fs.createReadStream:
// destroying one closes the descriptor even with autoClose off (Node 22),
// which can hit a descriptor number reused meanwhile.
const readAsync = require('util').promisify(fs.read);
async function* range(fd, start, end, size = 1024 * 1024) {
  let pos = start;
  while (end === undefined || pos < end) {
    const want = end === undefined ? size : Math.min(size, end - pos);
    const { bytesRead, buffer } = await readAsync(fd, Buffer.allocUnsafe(want), 0, want, pos);
    if (!bytesRead) return;
    pos += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got);
    if (!n) break;
    got += n;
  }
  return buf.subarray(0, got);
}

function zipDirectory(fd, size) {
  const tailLen = Math.min(size, 65557);
  const tail = readAt(fd, size - tailLen, tailLen);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw httpError('The zip is incomplete (no central directory); the upload may have been cut off');
  let count = tail.readUInt16LE(end + 10);
  let cdSize = tail.readUInt32LE(end + 12);
  let cdOff = tail.readUInt32LE(end + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const loc = end - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw httpError('The zip is damaged (Zip64 locator missing)');
    const z64 = Number(tail.readBigUInt64LE(loc + 8));
    const rec = readAt(fd, z64, 56);
    if (rec.length < 56 || rec.readUInt32LE(0) !== 0x06064b50) throw httpError('The zip is damaged (Zip64 record missing)');
    count = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOff = Number(rec.readBigUInt64LE(48));
  }
  if (cdOff + cdSize > size || cdSize > 512 * 1024 * 1024) throw httpError('The zip is damaged (central directory out of range)');
  if (count > MAX_ENTRIES) throw httpError(`The archive has more than ${MAX_ENTRIES.toLocaleString('en')} entries`);
  const cd = readAt(fd, cdOff, cdSize);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw httpError('The zip is damaged (central directory)');
    const madeBy = cd.readUInt16LE(p + 4) >> 8;
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    let comp = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const attrs = cd.readUInt32LE(p + 38);
    let local = cd.readUInt32LE(p + 42);
    const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(e);
      const len = extra.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        const big = () => {
          const v = q + 8 <= e + 4 + len ? Number(extra.readBigUInt64LE(q)) : NaN;
          q += 8;
          return v;
        };
        if (usize === 0xffffffff) usize = big();
        if (comp === 0xffffffff) comp = big();
        if (local === 0xffffffff) local = big();
      }
      e += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;
    // Bit 11: UTF-8 names. Without it the name is CP437, which matches
    // latin1 for the ASCII names worlds use.
    const name = nameBuf.toString(flags & 0x800 ? 'utf8' : 'latin1');
    entries.push({ name, flags, method, crc, comp, usize, local, madeBy, attrs });
  }
  return entries;
}

async function extractZip(fd, size, writer) {
  const entries = zipDirectory(fd, size);
  const total = entries.reduce((n, e) => n + (e.usize || 0), 0);
  if (total > writer.maxBytes) throw httpError(`The archive unpacks to ${gib(total)}, more than the free disk space allows (${gib(writer.maxBytes)})`);
  for (const e of entries) {
    const parts = entryParts(e.name);
    const unixType = e.madeBy === 3 ? (e.attrs >>> 16) & 0o170000 : 0;
    if (unixType === 0o120000) throw httpError(`The archive contains links (${parts.join('/')}); refusing it`);
    if (unixType && unixType !== 0o100000 && unixType !== 0o040000) throw httpError(`The archive contains special files (${parts.join('/')}); refusing it`);
    const isDir = e.name.endsWith('/') || e.name.endsWith('\\') || unixType === 0o040000 || (e.madeBy === 0 && e.attrs & 0x10);
    if (!parts.length || JUNK(parts)) continue;
    if (isDir) {
      writer.count();
      writer.dir(parts);
      continue;
    }
    if (e.flags & 1) throw httpError('The zip is password-protected; pack it again without a password');
    if (e.method !== 0 && e.method !== 8) throw httpError(`${parts.join('/')} is compressed with an unsupported method (${e.method}); zip it again with standard (Deflate) compression`);
    if (![e.comp, e.usize, e.local].every(Number.isSafeInteger)) throw httpError('The zip is damaged (entry sizes)');
    const head = readAt(fd, e.local, 30);
    if (head.length < 30 || head.readUInt32LE(0) !== 0x04034b50) throw httpError('The zip is damaged (local header)');
    const start = e.local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    if (start + e.comp > size) throw httpError('The zip is incomplete; the upload may have been cut off');
    let source;
    if (!e.comp) source = [];
    else {
      const raw = range(fd, start, start + e.comp);
      source = e.method === 8 ? stream.pipeline(stream.Readable.from(raw), zlib.createInflateRaw(), () => {}) : raw;
    }
    let got;
    try {
      got = await writer.file(parts, source, { crc: true });
    } catch (err) {
      if (err.status || !/incorrect|invalid|unexpected end/i.test(err.message)) throw err;
      throw httpError(`The zip is damaged (${parts.join('/')}: ${err.message}); try uploading it again`);
    }
    if (got.size !== e.usize || got.crc !== e.crc) throw httpError(`The zip is damaged (${parts.join('/')} fails its checksum); try uploading it again`);
  }
}

// --- archives ---------------------------------------------------------------------

const TOOLS = { zstd: ['zstd', ['-d', '-c', '-q', '--long=31']], xz: ['xz', ['-d', '-c', '-q']], bzip2: ['bzip2', ['-d', '-c', '-q']] };

// Decompresses with the command line tool, reading the archive through the
// descriptor (never by path).
function decompressor(format, fd) {
  const [cmd, args] = TOOLS[format];
  const child = spawn(cmd, args, { stdio: [fd, 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d).length > 4000 && (stderr = stderr.slice(-4000)));
  const exited = new Promise((resolve, reject) => {
    child.on('error', (err) => reject(err.code === 'ENOENT' ? new Error(`${cmd} is not installed (apt install ${cmd === 'xz' ? 'xz-utils' : cmd})`) : err));
    child.on('close', (code, signal) => (code === 0 || signal ? resolve() : reject(httpError(`The archive is damaged: ${stderr.trim().split('\n').pop() || `${cmd} exited with ${code}`}`))));
  });
  exited.catch(() => {});
  return { out: child.stdout, child, exited };
}

// Unpacks the archive open as `fd` into `root`. `maxBytes`: what may be
// written at most (the free disk space less a reserve).
async function extract(fd, root, { maxBytes, maxEntries } = {}) {
  const { size } = fs.fstatSync(fd);
  const head = readAt(fd, 0, 512);
  const format = detect(head);
  if (!format) throw httpError(explainUnknown(head));
  const writer = new Writer(root, { maxBytes, maxEntries });
  // Bytes a tar stream may carry beyond the files (headers, skipped entries).
  const limit = maxBytes + 1024 ** 3;
  if (format === 'zip') await extractZip(fd, size, writer);
  else if (format === 'tar' || format === 'gzip') {
    const raw = stream.Readable.from(range(fd, 0));
    const src = format === 'gzip' ? stream.pipeline(raw, zlib.createGunzip(), () => {}) : raw;
    try {
      await extractTar(src, writer, limit);
    } catch (err) {
      if (err.status) throw err;
      throw httpError(`The archive is damaged (${err.message}); try uploading it again`);
    } finally {
      src.destroy();
    }
  } else {
    const d = decompressor(format, fd);
    try {
      await extractTar(d.out, writer, limit);
      await d.exited;
    } catch (err) {
      d.child.kill();
      // A damaged stream fails the decompressor first; its message says more.
      await d.exited.catch((e) => {
        if (!err.status || /ends early|damaged|Not a tar/.test(err.message)) err = e;
      });
      throw err;
    }
  }
  return { format, files: writer.files, bytes: writer.bytes };
}

module.exports = { detect, explainUnknown, entryParts, extract, crc32 };

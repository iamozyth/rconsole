'use strict';
// Builds tar and zip archives byte by byte, including ones no well-behaved
// tool would write (links, "../" paths, bad checksums), plus level.dat files.

const zlib = require('zlib');
const { crc32 } = require('../lib/archive');

// --- NBT -----------------------------------------------------------------------------

function nbtString(s) {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

// Values: string, {int}, {long}, or a plain object (compound).
function nbtPayload(v) {
  if (typeof v === 'string') return [8, nbtString(v)];
  if (v && v.int !== undefined) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v.int);
    return [3, b];
  }
  if (v && v.long !== undefined) {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt(v.long));
    return [4, b];
  }
  const parts = [];
  for (const [k, x] of Object.entries(v)) {
    const [type, payload] = nbtPayload(x);
    parts.push(Buffer.from([type]), nbtString(k), payload);
  }
  parts.push(Buffer.from([0]));
  return [10, Buffer.concat(parts)];
}

// A level.dat as Minecraft writes it (gzip, root compound with Data).
function levelDat({ name = 'Survival', version = '1.21.10', dataVersion = 4556 } = {}) {
  const [, payload] = nbtPayload({
    Data: { LevelName: name, DataVersion: { int: dataVersion }, Version: { Name: version, Id: { int: dataVersion }, Snapshot: { int: 0 } }, LastPlayed: { long: Date.now() } },
  });
  return zlib.gzipSync(Buffer.concat([Buffer.from([10]), nbtString(''), payload]));
}

// --- tar -------------------------------------------------------------------------------

function tarHeader({ name, type = '0', size = 0, linkname = '', mode = 0o644, badChecksum = false }) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  h.write('0001750\0', 108);
  h.write('0001750\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(linkname, 157);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  if (badChecksum) sum += 1;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

const padTo512 = (n) => Buffer.alloc((512 - (n % 512)) % 512);

// entries: { name, data?, type?, linkname?, longName? }
function tar(entries, { end = true } = {}) {
  const out = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    if (Buffer.byteLength(e.name) > 100) {
      // GNU long name
      const n = Buffer.from(`${e.name}\0`);
      out.push(tarHeader({ name: '././@LongLink', type: 'L', size: n.length }), n, padTo512(n.length));
    }
    out.push(tarHeader({ ...e, size: e.type && e.type !== '0' ? 0 : data.length }));
    if (!e.type || e.type === '0') out.push(data, padTo512(data.length));
  }
  if (end) out.push(Buffer.alloc(1024));
  return Buffer.concat(out);
}

// --- zip ----------------------------------------------------------------------------------

// entries: { name, data?, mode? (unix, e.g. 0o120777 for a link), method? (0|8),
// encrypted?, badCrc? }. zip64: write every size and offset through the
// Zip64 extra field and records, as zips over 4 GB do.
function zip(entries, { zip64 = false, utf8 = true } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const method = e.method ?? (data.length ? 8 : 0);
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = e.badCrc ? (crc32(data) ^ 1) >>> 0 : crc32(data);
    const name = Buffer.from(e.name, 'utf8');
    const flags = (utf8 ? 0x800 : 0) | (e.encrypted ? 1 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(zip64 ? 0xffffffff : body.length, 18);
    local.writeUInt32LE(zip64 ? 0xffffffff : data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(1, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(data.length), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
    }
    local.writeUInt16LE(zip64 ? 20 : 0, 28);
    const localExtra = zip64 ? extra.subarray(0, 20) : Buffer.alloc(0);
    if (zip64) localExtra.writeUInt16LE(16, 2);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 45, 4); // made by Unix
    c.writeUInt16LE(zip64 ? 45 : 20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(zip64 ? 0xffffffff : body.length, 20);
    c.writeUInt32LE(zip64 ? 0xffffffff : data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(extra.length, 30);
    const mode = e.mode ?? (e.name.endsWith('/') ? 0o40755 : 0o100644);
    c.writeUInt32LE(((mode << 16) | (e.name.endsWith('/') ? 0x10 : 0)) >>> 0, 38);
    c.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    const fullExtra = zip64 ? Buffer.from(extra) : extra;
    if (zip64) fullExtra.writeUInt16LE(24, 2);
    locals.push(local, name, localExtra, body);
    central.push(c, name, fullExtra);
    offset += local.length + name.length + localExtra.length + body.length;
  }
  const cd = Buffer.concat(central);
  const tail = [];
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeUInt16LE(45, 12);
    rec.writeUInt16LE(45, 14);
    rec.writeBigUInt64LE(BigInt(entries.length), 24);
    rec.writeBigUInt64LE(BigInt(entries.length), 32);
    rec.writeBigUInt64LE(BigInt(cd.length), 40);
    rec.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(offset + cd.length), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(rec, loc);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return Buffer.concat([...locals, cd, ...tail, end]);
}

// A small world in the 26.x layout, as entries under `root` ('' = top level).
function worldEntries(root = 'MyWorld', { name = 'Survival', version } = {}) {
  const p = (s) => (root ? `${root}/${s}` : s);
  const region = Buffer.alloc(8192 + 4096, 7);
  return [
    { name: p('level.dat'), data: levelDat({ name, version }) },
    { name: p('level.dat_old'), data: levelDat({ name, version }) },
    { name: p('session.lock'), data: '☃' },
    { name: p('dimensions/minecraft/overworld/region/r.0.0.mca'), data: region },
    { name: p('dimensions/minecraft/overworld/region/r.-1.0.mca'), data: region },
    { name: p('dimensions/minecraft/the_nether/region/r.0.0.mca'), data: region },
    { name: p('dimensions/minecraft/the_end/region/r.0.0.mca'), data: region },
    { name: p('players/data/0b6a1a56-4f30-4c62-8d7c-1a2b3c4d5e6f.dat'), data: levelDat() },
    { name: p('datapacks/'), data: '' },
  ];
}

module.exports = { levelDat, tar, zip, worldEntries };

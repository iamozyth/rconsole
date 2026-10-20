'use strict';

// Region files (r.<x>.<z>.mca, Anvil): 32×32 chunks, a 4 KiB table of where
// each chunk sits (offset and length in 4 KiB sectors), a 4 KiB table of
// when each was saved, then the chunks: 4 bytes length, 1 byte compression,
// the compressed NBT. A chunk too big for 255 sectors keeps only that byte
// here (with bit 128 set) and its data in c.<x>.<z>.mcc next to the file.
// The same format holds blocks (region/), entities (entities/) and points
// of interest (poi/). Used by the area restore: chunks are copied as the
// bytes they are, never recompressed.

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const SECTOR = 4096;
const DIMENSIONS = ['overworld', 'nether', 'the_end'];
const KINDS = ['region', 'entities', 'poi'];
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

const chunkOf = (block) => Math.floor(block / 16);
const regionOf = (chunk) => Math.floor(chunk / 32);
const indexOf = (cx, cz) => (cx & 31) + (cz & 31) * 32;
const regionName = (rx, rz) => `r.${rx}.${rz}.mca`;
const externalName = (cx, cz) => `c.${cx}.${cz}.mcc`;

// Where a dimension's folders live, relative to the server folder, newest
// layout first: 26.x keeps them under <world>/dimensions/minecraft/<name>,
// vanilla before that in <world> (DIM-1, DIM1), Bukkit next to the world.
function dimensionRoots(world, dimension) {
  if (dimension === 'overworld') return [path.join(world, 'dimensions', 'minecraft', 'overworld'), world];
  if (dimension === 'nether') return [path.join(world, 'dimensions', 'minecraft', 'the_nether'), path.join(world, 'DIM-1'), path.join(`${world}_nether`, 'DIM-1')];
  if (dimension === 'the_end') return [path.join(world, 'dimensions', 'minecraft', 'the_end'), path.join(world, 'DIM1'), path.join(`${world}_the_end`, 'DIM1')];
  throw new Error('Invalid dimension');
}

// The first of those roots that has block data under `base`.
function findRoot(base, world, dimension) {
  return dimensionRoots(world, dimension).find((r) => fs.existsSync(path.join(base, r, 'region'))) || null;
}

// tar patterns for the files an area needs from a backup: the region files
// in every layout the backup may use, and any oversized chunks next to them.
function members(world, dimension, regionKeys, kinds = KINDS) {
  const out = [];
  for (const root of dimensionRoots(world, dimension)) {
    for (const kind of kinds) {
      for (const key of regionKeys) {
        const [rx, rz] = key.split(',');
        out.push(path.join(root, kind, regionName(rx, rz)));
      }
      out.push(path.join(root, kind, 'c.*.mcc'));
    }
  }
  return out;
}

// -> Array(1024) of { data, time, external } (data: the length-prefixed
// record without padding) or null for chunks that were never saved.
function parse(buf) {
  const chunks = new Array(1024).fill(null);
  if (!buf || buf.length < 2 * SECTOR) return chunks;
  for (let i = 0; i < 1024; i++) {
    const loc = buf.readUInt32BE(i * 4);
    const offset = loc >>> 8;
    const count = loc & 0xff;
    if (!offset || !count || offset < 2) continue;
    const start = offset * SECTOR;
    if (start + 5 > buf.length) continue;
    const length = buf.readUInt32BE(start);
    if (length < 1 || length > count * SECTOR - 4 || start + 4 + length > buf.length) continue;
    const data = buf.subarray(start, start + 4 + length);
    chunks[i] = { data, time: buf.readUInt32BE(SECTOR + i * 4), external: (data[4] & 0x80) !== 0 };
  }
  return chunks;
}

// The chunks back into a file, packed from sector 2 on.
function serialize(chunks) {
  const header = Buffer.alloc(2 * SECTOR);
  const parts = [header];
  let sector = 2;
  for (let i = 0; i < 1024; i++) {
    const c = chunks[i];
    if (!c) continue;
    const sectors = Math.ceil(c.data.length / SECTOR);
    if (sectors > 255) throw new Error('Chunk too large for a region file');
    header.writeUInt32BE(((sector << 8) | sectors) >>> 0, i * 4);
    header.writeUInt32BE(c.time >>> 0, SECTOR + i * 4);
    parts.push(c.data);
    const pad = sectors * SECTOR - c.data.length;
    if (pad) parts.push(Buffer.alloc(pad));
    sector += sectors;
  }
  return Buffer.concat(parts);
}

// A chunk's NBT (null when it is stored outside or compressed with LZ4,
// which Node can't read).
function inflate(c) {
  if (!c || c.external) return null;
  const type = c.data[4];
  const body = c.data.subarray(5);
  const opts = { maxOutputLength: MAX_CHUNK_BYTES };
  if (type === 1) return zlib.gunzipSync(body, opts);
  if (type === 2) return zlib.inflateSync(body, opts);
  if (type === 3) return Buffer.from(body);
  return null;
}

// The chunks an area covers, from block corners (either order), as [cx, cz].
function chunksIn({ x1, z1, x2, z2 }) {
  const [ax, bx] = [chunkOf(Math.min(x1, x2)), chunkOf(Math.max(x1, x2))];
  const [az, bz] = [chunkOf(Math.min(z1, z2)), chunkOf(Math.max(z1, z2))];
  const out = [];
  for (let cz = az; cz <= bz; cz++) for (let cx = ax; cx <= bx; cx++) out.push([cx, cz]);
  return out;
}

// Chunks grouped by the region file they are in: "rx,rz" -> [[cx, cz], …].
function byRegion(chunks) {
  const out = new Map();
  for (const [cx, cz] of chunks) {
    const key = `${regionOf(cx)},${regionOf(cz)}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push([cx, cz]);
  }
  return out;
}

module.exports = { SECTOR, DIMENSIONS, KINDS, chunkOf, regionOf, indexOf, regionName, externalName, dimensionRoots, findRoot, members, parse, serialize, inflate, chunksIn, byRegion };

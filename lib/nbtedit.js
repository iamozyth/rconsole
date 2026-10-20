'use strict';

// Binary NBT that survives a round trip: lib/nbt.js turns a file into plain
// values (fine for showing it), this keeps every tag's type and raw bytes so
// a player file can be changed in one place and written back exactly as
// Minecraft wrote the rest. Compounds keep their order; numbers, strings and
// arrays stay the bytes they were.

const zlib = require('zlib');

const MAX_DEPTH = 64;
const FIXED = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 4, 6: 8 };
const ARRAY = { 7: 1, 11: 4, 12: 8 };

// -> { gzip, name, root } where root is { type: 10, entries: [[name, tag], …] }
function parse(input) {
  const gzip = input[0] === 0x1f && input[1] === 0x8b;
  const buf = gzip ? zlib.gunzipSync(input, { maxOutputLength: 32 * 1024 * 1024 }) : input;
  let i = 0;
  const need = (n) => {
    if (i + n > buf.length) throw new Error('NBT: unexpected end of data');
  };
  const take = (n) => (need(n), (i += n), buf.subarray(i - n, i));
  const str = () => {
    need(2);
    const n = buf.readUInt16BE(i);
    i += 2;
    return Buffer.from(take(n));
  };
  const tag = (type, depth) => {
    if (depth > MAX_DEPTH) throw new Error('NBT: nested too deeply');
    if (FIXED[type]) return { type, raw: Buffer.from(take(FIXED[type])) };
    if (ARRAY[type]) {
      need(4);
      const n = buf.readInt32BE(i);
      if (n < 0 || n * ARRAY[type] > buf.length) throw new Error('NBT: bad array length');
      return { type, raw: Buffer.from(take(4 + n * ARRAY[type])) };
    }
    if (type === 8) return { type, raw: str() };
    if (type === 9) {
      need(5);
      const of = buf[i++];
      const n = buf.readInt32BE(i);
      i += 4;
      if (n < 0 || n > buf.length) throw new Error('NBT: bad list length');
      return { type, of, items: Array.from({ length: n }, () => tag(of, depth + 1)) };
    }
    if (type === 10) {
      const entries = [];
      for (;;) {
        need(1);
        const t = buf[i++];
        if (t === 0) return { type, entries };
        entries.push([str().toString('utf8'), tag(t, depth + 1)]);
      }
    }
    throw new Error(`NBT: unknown tag ${type}`);
  };
  need(1);
  if (buf[i++] !== 10) throw new Error('NBT: root is not a compound');
  const rootName = str();
  const root = tag(10, 0);
  if (i !== buf.length) throw new Error('NBT: data after the root compound');
  return { gzip, name: rootName, root };
}

// The bytes of one tag's payload (to compare two subtrees).
function bytes(t) {
  const parts = [];
  encode(t, parts);
  return Buffer.concat(parts);
}

function serialize({ gzip, name, root }) {
  const parts = [Buffer.from([10])];
  pushStr(parts, name);
  encode(root, parts);
  const out = Buffer.concat(parts);
  return gzip ? zlib.gzipSync(out) : out;
}

function pushStr(parts, b) {
  const n = Buffer.alloc(2);
  n.writeUInt16BE(b.length);
  parts.push(n, b);
}

function encode(t, parts) {
  if (FIXED[t.type] || ARRAY[t.type]) return parts.push(t.raw);
  if (t.type === 8) return pushStr(parts, t.raw);
  if (t.type === 9) {
    const n = Buffer.alloc(4);
    n.writeInt32BE(t.items.length);
    parts.push(Buffer.from([t.of]), n);
    for (const x of t.items) encode(x, parts);
    return;
  }
  for (const [k, v] of t.entries) {
    parts.push(Buffer.from([v.type]));
    pushStr(parts, Buffer.from(k, 'utf8'));
    encode(v, parts);
  }
  parts.push(Buffer.from([0]));
}

const get = (compound, key) => compound?.entries?.find(([k]) => k === key)?.[1];

// Sets (or, with undefined, removes) one entry of a compound in place.
function set(compound, key, value) {
  const i = compound.entries.findIndex(([k]) => k === key);
  if (value === undefined) {
    if (i >= 0) compound.entries.splice(i, 1);
  } else if (i >= 0) compound.entries[i][1] = value;
  else compound.entries.push([key, value]);
}

module.exports = { parse, serialize, bytes, get, set };

'use strict';

// A reader for binary NBT as Minecraft stores it in players/data/<uuid>.dat
// (gzip-compressed, big-endian). Produces the same plain values as the SNBT
// parser: compounds become objects, lists and typed arrays become arrays,
// longs become numbers (precision beyond 2^53 is not needed here).

const zlib = require('zlib');

const MAX_DEPTH = 64;

function read(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf, { maxOutputLength: 32 * 1024 * 1024 });
  let i = 0;
  const need = (n) => {
    if (i + n > buf.length) throw new Error('NBT: unexpected end of data');
  };
  const u8 = () => (need(1), buf.readInt8(i++));
  const i16 = () => (need(2), (i += 2), buf.readInt16BE(i - 2));
  const i32 = () => (need(4), (i += 4), buf.readInt32BE(i - 4));
  const i64 = () => (need(8), (i += 8), Number(buf.readBigInt64BE(i - 8)));
  const str = () => {
    need(2);
    const n = buf.readUInt16BE(i);
    i += 2;
    need(n);
    i += n;
    return buf.toString('utf8', i - n, i); // modified UTF-8; fine for ids and names
  };
  const arr = (fn) => {
    const n = i32();
    if (n < 0 || n > buf.length) throw new Error('NBT: bad array length');
    return Array.from({ length: n }, fn);
  };
  const payload = (type, depth) => {
    if (depth > MAX_DEPTH) throw new Error('NBT: nested too deeply');
    switch (type) {
      case 1: return u8();
      case 2: return i16();
      case 3: return i32();
      case 4: return i64();
      case 5: return (need(4), (i += 4), buf.readFloatBE(i - 4));
      case 6: return (need(8), (i += 8), buf.readDoubleBE(i - 8));
      case 7: return arr(u8);
      case 8: return str();
      case 9: {
        need(1);
        const t = buf[i++];
        return arr(() => payload(t, depth + 1));
      }
      case 10: {
        const obj = {};
        for (;;) {
          need(1);
          const t = buf[i++];
          if (t === 0) return obj;
          obj[str()] = payload(t, depth + 1);
        }
      }
      case 11: return arr(i32);
      case 12: return arr(i64);
      default: throw new Error(`NBT: unknown tag ${type}`);
    }
  };
  need(1);
  const t = buf[i++];
  if (t !== 10) throw new Error('NBT: root is not a compound');
  str();
  return payload(10, 0);
}

module.exports = { read };

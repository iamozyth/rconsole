'use strict';

// Just enough ZIP to read plugin.yml out of a plugin jar: find the central
// directory, look an entry up by name, inflate it. Size limits keep a hostile
// jar from exhausting memory.

const fs = require('fs');
const zlib = require('zlib');

const MAX_ENTRY = 1024 * 1024; // plugin.yml is a few KB

function findEnd(buf) {
  // End of central directory record: signature 0x06054b50, within the last 64 KB + 22 bytes.
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('Not a zip file');
}

// Returns the named entry's contents, or null when the jar doesn't have it.
function readEntry(buf, wanted) {
  const end = findEnd(buf);
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== wanted) continue;
    if (size > MAX_ENTRY || compSize > MAX_ENTRY) throw new Error(`${wanted} is too large`);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('Corrupt local header');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compSize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
    throw new Error(`Unsupported compression method ${method}`);
  }
  return null;
}

function readFileEntry(file, wanted) {
  return readEntry(fs.readFileSync(file), wanted);
}

module.exports = { readEntry, readFileEntry };

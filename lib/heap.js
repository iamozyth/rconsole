'use strict';

// How much of the Java heap a server really uses, from the GC log the
// servers rconsole runs write (logs/gc.log, see lib/instances.js). The JVM
// reserves and touches its whole heap up front (-Xms, AlwaysPreTouch), so
// the process's memory says little; after a collection the heap holds only
// live data, and before the next one it shows what accumulated since.
//
//   [2026-10-18T19:00:00.123+0200] GC(12) Pause Young (Normal) (G1 Evacuation Pause) 1203M->402M(4096M) 5.123ms

const fs = require('fs');
const path = require('path');

// Only collections that free memory (young, mixed, full); remark and cleanup
// phases don't, so their numbers aren't "in use after the collection".
const LINE_RE = /^\[([^\]]+)\].*GC\(\d+\) Pause (?:Young|Full).* (\d+)([KMG])->(\d+)([KMG])\((\d+)([KMG])\)/;
const UNIT = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
const TAIL = 64 * 1024;

function tail(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// { used, before, committed, at, collections, peak } in bytes, or null.
// used: live data after the last collection; before: what the heap held
// when it started; peak: the most it held in the lines read.
function parse(text) {
  const gcs = [];
  for (const line of text.split('\n')) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const at = Date.parse(m[1].replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    gcs.push({ before: m[2] * UNIT[m[3]], used: m[4] * UNIT[m[5]], committed: m[6] * UNIT[m[7]], at: Number.isFinite(at) ? new Date(at).toISOString() : null });
  }
  if (!gcs.length) return null;
  const last = gcs[gcs.length - 1];
  return { ...last, collections: gcs.length, peak: Math.max(...gcs.map((g) => g.before)) };
}

function read(mcDir) {
  return parse(tail(path.join(mcDir, 'logs', 'gc.log')));
}

module.exports = { read, parse };

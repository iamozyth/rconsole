'use strict';

// Reading the server's logs: logs/latest.log plus the rotated
// logs/YYYY-MM-DD-N.log.gz files. Log lines only carry a time of day, so
// dates are reconstructed per file: rotated files start on the date in their
// name, latest.log ends on the date it was last written. Every time the clock
// goes backwards within a file, a day has passed.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const ROTATED_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d+)\.log(\.gz)?$/;
// "[12:34:56] [Server thread/INFO]: msg" (vanilla/Paper file) or
// "[12:34:56 INFO]: msg" (Paper console format).
// Forge/NeoForge: "[12Oct2026 12:34:56.789] [Server thread/INFO] [net.minecraft.server.Foo/]: msg"
// (date before the time, logger after the level); both are optional here.
const LINE_RE = /^\[(?:\d{1,2}[A-Za-z]{3}\d{4} )?(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\](?: \[([^\]]*?)\/([A-Z]+)\])?(?: \[[^\]]*\])?:? ?(.*)$/;
const LINE_RE_2 = /^\[(\d{2}):(\d{2}):(\d{2}) ([A-Z]+)\]:? ?(.*)$/;

function parseLine(line) {
  let m = line.match(LINE_RE_2);
  if (m) return { secs: m[1] * 3600 + m[2] * 60 + Number(m[3]), thread: null, level: m[4], msg: m[5] };
  m = line.match(LINE_RE);
  if (!m) return null;
  return { secs: m[1] * 3600 + m[2] * 60 + Number(m[3]), thread: m[4] || null, level: m[5] || 'INFO', msg: m[6] };
}

async function listFiles(logsDir) {
  let names;
  try {
    names = await fs.promises.readdir(logsDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    const m = name.match(ROTATED_RE);
    if (!m && name !== 'latest.log') continue;
    const stat = await fs.promises.stat(path.join(logsDir, name)).catch(() => null);
    if (!stat?.isFile()) continue;
    out.push({
      name,
      path: path.join(logsDir, name),
      gz: name.endsWith('.gz'),
      latest: !m,
      date: m ? `${m[1]}-${m[2]}-${m[3]}` : null,
      index: m ? Number(m[4]) : Infinity,
      size: stat.size,
      mtime: stat.mtimeMs,
    });
  }
  // Oldest first; latest.log last.
  return out.sort((a, b) => (a.latest - b.latest) || (a.date || '').localeCompare(b.date || '') || a.index - b.index);
}

const localDay = (ms) => {
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
};

// Calls pick(parsed, raw) for every line; whatever it returns (other than
// undefined) is collected with a timestamp `t` (ms). Returns { items, first,
// last, stopped } with first/last line timestamps. `stop()` returning true
// ends the scan early (time budgets). `more(raw)` receives lines without a
// timestamp, e.g. stack traces belonging to the line before.
async function scanFile(file, pick, { stop, more } = {}) {
  const input = fs.createReadStream(file.path);
  const stream = file.gz ? input.pipe(zlib.createGunzip()) : input;
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const raw = []; // [offsetDays, secs, item]
  let offset = 0;
  let prev = -1;
  let firstSecs = null;
  let stopped = false;
  try {
    for await (const line of rl) {
      const p = parseLine(line);
      if (!p) {
        more?.(line);
        continue;
      }
      if (firstSecs === null) firstSecs = p.secs;
      if (p.secs < prev) offset++;
      prev = p.secs;
      const item = pick(p, line);
      if (item !== undefined) raw.push([offset, p.secs, item]);
      if (stop?.()) {
        stopped = true;
        break;
      }
    }
  } catch (err) {
    if (!/unexpected end of file/i.test(err.message)) throw err; // truncated .gz: keep what we read
  } finally {
    rl.close();
    input.destroy();
  }
  let base;
  if (file.latest) {
    // Last line is on the day of the last write, unless its time is later
    // than the write time (written just before midnight, flushed after).
    let [y, m, d] = localDay(file.mtime);
    const mt = new Date(file.mtime);
    const mtSecs = mt.getHours() * 3600 + mt.getMinutes() * 60 + mt.getSeconds();
    if (!stopped && prev > mtSecs + 60) d -= 1;
    base = [y, m, d - offset];
  } else {
    const [y, m, d] = file.date.split('-').map(Number);
    base = [y, m, d];
  }
  const at = (off, secs) => new Date(base[0], base[1] - 1, base[2] + off, 0, 0, secs).getTime();
  return {
    items: raw.map(([off, secs, item]) => ({ ...item, t: at(off, secs) })),
    first: firstSecs === null ? null : at(0, firstSecs),
    last: prev < 0 ? null : at(offset, prev),
    stopped,
  };
}

module.exports = { listFiles, scanFile, parseLine, ROTATED_RE };

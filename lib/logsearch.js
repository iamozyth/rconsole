'use strict';

// Search across latest.log and the rotated .log.gz files, newest first, with
// a result cap and a time budget so a vague query can't tie up the server.

const path = require('path');
const { listFiles, scanFile } = require('./logfiles');

const MAX_RESULTS = 500;
const BUDGET_MS = 8000;
const LEVELS = ['INFO', 'WARN', 'ERROR'];

const dayStart = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};

async function searchLogs(mcDir, { q = '', player = '', level = '', from = '', to = '', limit = MAX_RESULTS } = {}) {
  const needle = String(q).slice(0, 200).toLowerCase();
  const who = String(player).slice(0, 16).toLowerCase();
  const lvl = LEVELS.includes(level) ? level : '';
  const fromMs = /^\d{4}-\d{2}-\d{2}$/.test(from) ? dayStart(from) : null;
  const toMs = /^\d{4}-\d{2}-\d{2}$/.test(to) ? dayStart(to) + 86400000 : null;
  if (!needle && !who && !lvl) throw Object.assign(new Error('Enter a search term, a player or a level'), { status: 400 });
  const max = Math.min(Number(limit) || MAX_RESULTS, MAX_RESULTS);

  const files = (await listFiles(path.join(mcDir, 'logs'))).reverse(); // newest first
  const deadline = Date.now() + BUDGET_MS;
  const results = [];
  let scanned = 0;
  let truncated = false;
  let timedOut = false;

  for (const f of files) {
    // Rotated files hold one server run; skip those that start after the
    // range or ended (by the next file's start) well before it.
    if (!f.latest && toMs && dayStart(f.date) >= toMs) continue;
    if (!f.latest && fromMs && dayStart(f.date) < fromMs - 7 * 86400000) break;
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    const r = await scanFile(f, (p, raw) => {
      if (lvl && p.level !== lvl && !(lvl === 'WARN' && p.level === 'ERROR')) return undefined;
      const low = raw.toLowerCase();
      if (needle && !low.includes(needle)) return undefined;
      if (who && !new RegExp(`(^|[^a-z0-9_])${who.replace(/[^a-z0-9_.]/g, '')}([^a-z0-9_]|$)`).test(p.msg.toLowerCase())) return undefined;
      return { level: p.level, thread: p.thread, msg: p.msg.slice(0, 2000) };
    }, { stop: () => Date.now() > deadline });
    scanned++;
    if (r.stopped) timedOut = true;
    const inRange = r.items.filter((i) => (fromMs == null || i.t >= fromMs) && (toMs == null || i.t < toMs)).reverse();
    for (const i of inRange) {
      if (results.length >= max) {
        truncated = true;
        break;
      }
      results.push({ ...i, file: f.name });
    }
    if (truncated || timedOut) break;
  }
  return { results, scanned, files: files.length, truncated, timedOut };
}

module.exports = { searchLogs, LEVELS };

'use strict';

// Cron expressions for scheduled tasks: five fields (minute, hour, day of
// month, month, day of week) with *, lists, ranges and steps, plus month and
// day names. Like Vixie cron, when both day of month and day of week are
// restricted, a day matching either one counts. Times are the host's local
// time, as for the daily tasks.

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], base: 1 },
  { name: 'day of week', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], base: 0 },
];

const MACROS = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

function value(raw, f) {
  const s = raw.toLowerCase();
  const named = f.names ? f.names.indexOf(s) : -1;
  if (named >= 0) return named + f.base;
  if (!/^\d{1,2}$/.test(s)) throw new Error(`${f.name}: "${raw}" is not a number`);
  const n = Number(s);
  if (n < f.min || n > f.max) throw new Error(`${f.name}: ${n} is outside ${f.min}-${f.max}`);
  return n;
}

// One field as a set of the values it matches, plus whether it was "*".
function field(text, f) {
  const set = new Set();
  for (const part of text.split(',')) {
    const m = part.match(/^([^/]+)(?:\/(\d{1,2}))?$/);
    if (!m) throw new Error(`${f.name}: "${part}" isn't valid`);
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) throw new Error(`${f.name}: the step must be 1 or more`);
    let lo;
    let hi;
    if (m[1] === '*') [lo, hi] = [f.min, f.name === 'day of week' ? 6 : f.max];
    else if (m[1].includes('-')) {
      const [a, b] = m[1].split('-');
      [lo, hi] = [value(a, f), value(b, f)];
      if (lo > hi) throw new Error(`${f.name}: ${a}-${b} runs backwards`);
    } else {
      lo = value(m[1], f);
      hi = m[2] === undefined ? lo : f.max;
    }
    for (let v = lo; v <= hi; v += step) set.add(f.name === 'day of week' && v === 7 ? 0 : v);
  }
  return { set, any: text === '*' || text === '*/1' };
}

function parse(expr) {
  const raw = String(expr || '').trim().replace(/\s+/g, ' ');
  if (raw.length > 100) throw new Error('The cron expression is too long');
  const text = MACROS[raw.toLowerCase()] || raw;
  const parts = text.split(' ');
  if (parts.length !== 5) throw new Error('A cron expression has five fields: minute hour day month weekday');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => field(p, FIELDS[i]));
  return { expr: raw, minute, hour, dom, month, dow };
}

function dayMatches(c, d) {
  const domOk = c.dom.set.has(d.getDate());
  const dowOk = c.dow.set.has(d.getDay());
  if (c.dom.any && c.dow.any) return true;
  if (c.dom.any) return dowOk;
  if (c.dow.any) return domOk;
  return domOk || dowOk;
}

// The first matching minute after `from`, or null within about four years
// (an expression like "0 0 31 2 *" never matches).
function next(expr, from = new Date()) {
  const c = typeof expr === 'string' ? parse(expr) : expr;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 4 * 366 * 86400 * 1000;
  while (d.getTime() <= limit) {
    if (!c.month.set.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.set.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.set.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  return null;
}

module.exports = { parse, next };

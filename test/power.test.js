'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseTimestamp, sinceOf } = require('../lib/power');

test('parseTimestamp reads systemd formats', () => {
  assert.strictEqual(parseTimestamp('@1760218007'), 1760218007000);
  assert.strictEqual(parseTimestamp('Sun 2026-10-11 23:26:47 CEST'), new Date(2026, 9, 11, 23, 26, 47).getTime());
  assert.strictEqual(parseTimestamp('n/a'), null);
  assert.strictEqual(parseTimestamp(''), null);
});

test('sinceOf: a clock stepped back after boot (papermc 2026-10-20) uses the monotonic start', () => {
  // Booted with the clock 2 h fast: systemd noted 23:32:39 for a unit that
  // started 5 s after boot; 275 s later NTP has fixed the clock (21:37:09).
  const now = new Date(2026, 9, 20, 21, 37, 9).getTime();
  const p = { ActiveEnterTimestamp: `@${Math.floor(new Date(2026, 9, 20, 23, 32, 39).getTime() / 1000)}`, ActiveEnterTimestampMonotonic: '5162853' };
  const since = sinceOf(p, 275.47, now);
  assert.ok(Math.abs(since - (now - 270307)) < 2, new Date(since).toString());
  // Without a usable monotonic time: the wall-clock one.
  assert.strictEqual(sinceOf({ ActiveEnterTimestamp: '@1760218007', ActiveEnterTimestampMonotonic: '0' }, 100, now), 1760218007000);
  assert.strictEqual(sinceOf({ ActiveEnterTimestamp: '@1760218007' }, 100, now), 1760218007000);
});

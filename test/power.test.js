'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseTimestamp } = require('../lib/power');

test('parseTimestamp reads systemd formats', () => {
  assert.strictEqual(parseTimestamp('@1760218007'), 1760218007000);
  assert.strictEqual(parseTimestamp('Sun 2026-10-11 23:26:47 CEST'), new Date(2026, 9, 11, 23, 26, 47).getTime());
  assert.strictEqual(parseTimestamp('n/a'), null);
  assert.strictEqual(parseTimestamp(''), null);
});

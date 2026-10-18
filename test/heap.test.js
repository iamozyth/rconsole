'use strict';
const test = require('node:test');
const assert = require('node:assert');
const heap = require('../lib/heap');

const M = 1024 ** 2;

test('heap in use comes from the last collection in the GC log', () => {
  const log = [
    '[2026-10-18T19:00:00.123+0200] Using G1',
    '[2026-10-18T19:00:05.000+0200] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 1203M->402M(4096M) 5.123ms',
    '[2026-10-18T19:01:05.000+0200] GC(1) Pause Young (Concurrent Start) (G1 Humongous Allocation) 2100M->650M(4096M) 9.001ms',
    '[2026-10-18T19:01:05.100+0200] GC(2) Concurrent Mark Cycle 12.3ms',
  ].join('\n');
  assert.deepStrictEqual(heap.parse(log), {
    before: 2100 * M, used: 650 * M, committed: 4096 * M, at: '2026-10-18T17:01:05.000Z', collections: 2, peak: 2100 * M,
  });
});

test('no collections yet, or no log: nothing to show', () => {
  assert.strictEqual(heap.parse('[2026-10-18T19:00:00.123+0200] Using G1\n'), null);
  assert.strictEqual(heap.read('/nonexistent'), null);
});

test('full collections and gigabyte units are read too', () => {
  const r = heap.parse('[2026-10-18T19:00:00.000+0000] GC(9) Pause Full (System.gc()) 3G->1G(4G) 800.0ms');
  assert.deepStrictEqual([r.before, r.used, r.committed], [3 * 1024 * M, 1024 * M, 4 * 1024 * M]);
});

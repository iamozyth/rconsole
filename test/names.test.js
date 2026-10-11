'use strict';
const test = require('node:test');
const assert = require('node:assert');
const n = require('../lib/names');

test('world names', () => {
  for (const ok of ['world', 'Creative_2', 'a-b']) assert.ok(n.isWorldName(ok), ok);
  for (const bad of ['', 'world_nether', 'x_the_end', '../x', 'a b', 'a.b', '-x', 'x'.repeat(33)]) assert.ok(!n.isWorldName(bad), bad);
});

test('backup names, including legacy world-<stamp>', () => {
  assert.deepEqual(n.parseBackupName('world-2026-10-11_22-31-32.tar.gz'), { world: 'world', stamp: '2026-10-11_22-31-32' });
  assert.deepEqual(n.parseBackupName('my-world-2026-10-11_22-31-32.tar.gz'), { world: 'my-world', stamp: '2026-10-11_22-31-32' });
  assert.equal(n.parseBackupName('world-2026-10-11.tar.gz'), null);
  assert.equal(n.parseBackupName('../x-2026-10-11_22-31-32.tar.gz'), null);
});

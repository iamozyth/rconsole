'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dirSize, dimensionsOf } = require('../lib/worlds');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-worlds-'));
const touch = (file, bytes = 10) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
};

test('dimensions next to the world (Bukkit) and inside it (vanilla)', () => {
  const dir = tmp();
  touch(path.join(dir, 'world', 'level.dat'));
  touch(path.join(dir, 'world_nether', 'DIM-1', 'region', 'r.0.0.mca'));
  touch(path.join(dir, 'world_the_end', 'DIM1', 'region', 'r.0.0.mca'));
  assert.deepStrictEqual(dimensionsOf(dir, 'world'), ['overworld', 'nether', 'the_end']);
  touch(path.join(dir, 'vanilla', 'level.dat'));
  touch(path.join(dir, 'vanilla', 'DIM-1', 'region', 'r.0.0.mca'));
  assert.deepStrictEqual(dimensionsOf(dir, 'vanilla'), ['overworld', 'nether']);
});

test('26.x keeps every dimension under dimensions/<namespace>', () => {
  const dir = tmp();
  touch(path.join(dir, 'world', 'level.dat'));
  for (const d of ['overworld', 'the_nether', 'the_end']) touch(path.join(dir, 'world', 'dimensions', 'minecraft', d, 'region', 'r.0.0.mca'));
  touch(path.join(dir, 'world', 'dimensions', 'mymod', 'moon', 'region', 'r.0.0.mca'));
  assert.deepStrictEqual(dimensionsOf(dir, 'world'), ['overworld', 'nether', 'the_end', 'mymod:moon']);
});

test('dirSize counts unreadable folders instead of hiding them', async () => {
  const dir = tmp();
  touch(path.join(dir, 'w', 'a'), 100);
  touch(path.join(dir, 'w', 'locked', 'b'), 50);
  assert.deepStrictEqual(await dirSize(path.join(dir, 'w')), { size: 150, unreadable: 0 });
  assert.deepStrictEqual(await dirSize(path.join(dir, 'missing')), { size: 0, unreadable: 0 });
  if (process.getuid?.() === 0) return; // root reads everything
  fs.chmodSync(path.join(dir, 'w', 'locked'), 0o000);
  try {
    assert.deepStrictEqual(await dirSize(path.join(dir, 'w')), { size: 100, unreadable: 1 });
  } finally {
    fs.chmodSync(path.join(dir, 'w', 'locked'), 0o755);
  }
});

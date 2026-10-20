'use strict';
// Resumable uploads: chunks in order, resuming after a cut, early rejection
// of files that aren't archives, cleanup.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { Uploads } = require('../lib/uploads');
const { explainNotWorld } = require('../lib/worldimport');
const { zip, worldEntries } = require('./archives');

const make = (opts = {}) => new Uploads({ backupDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-uploads-')), ...opts });
const body = (buf, { cutAfter } = {}) => {
  const r = new Readable({ read() {} });
  r.headers = cutAfter === undefined ? { 'content-length': String(buf.length) } : {};
  if (cutAfter === undefined) {
    r.push(buf);
    r.push(null);
  } else {
    r.push(buf.subarray(0, cutAfter));
    setImmediate(() => r.destroy(new Error('aborted')));
  }
  return r;
};

test('chunks append in order and the upload completes', async () => {
  const u = make();
  const file = zip(worldEntries());
  const up = u.create({ name: 'MyWorld.zip', size: file.length, user: 'masseo' });
  assert.equal(up.received, 0);
  const half = Math.floor(file.length / 2);
  let st = await u.append(up.id, 0, body(file.subarray(0, half)), 'masseo');
  assert.equal(st.received, half);
  await assert.rejects(u.append(up.id, 0, body(file.subarray(0, half)), 'masseo'), (e) => e.status === 409 && /continues at byte/.test(e.message));
  st = await u.append(up.id, half, body(file.subarray(half)), 'masseo');
  assert.ok(st.complete);
  assert.deepEqual(fs.readFileSync(path.join(u.dir, `${up.id}.part`)), file);
  if (process.getuid?.() !== 0) assert.equal(fs.statSync(path.join(u.dir, `${up.id}.part`)).mode & 0o777, 0o640);
});

test('a cut connection keeps what arrived, and the upload resumes from there', async () => {
  const u = make();
  const file = zip(worldEntries());
  const up = u.create({ name: 'w.zip', size: file.length, user: 'a' });
  await assert.rejects(u.append(up.id, 0, body(file, { cutAfter: 1000 }), 'a'), /interrupted/);
  // What reached the disk before the cut (pending writes may be dropped).
  const { received } = u.status(up.id);
  assert.ok(received <= 1000);
  const st = await u.append(up.id, received, body(file.subarray(received)), 'a');
  assert.ok(st.complete);
  assert.deepEqual(fs.readFileSync(path.join(u.dir, `${up.id}.part`)), file);
});

test('chunks past the announced size and other people\'s uploads are refused', async () => {
  const u = make();
  const up = u.create({ name: 'w.zip', size: 600, user: 'a' });
  await assert.rejects(u.append(up.id, 0, body(Buffer.alloc(700)), 'a'), (e) => e.status === 413);
  await assert.rejects(u.append(up.id, 0, body(Buffer.alloc(10)), 'b'), (e) => e.status === 403);
  assert.throws(() => u.status('../../etc'), (e) => e.status === 404);
});

test('a file that is not an archive is rejected with the first chunk', async () => {
  const u = make({ explain: explainNotWorld });
  const junk = Buffer.concat([Buffer.from('Rar!\x1a\x07\x00'), Buffer.alloc(2000, 1)]);
  const up = u.create({ name: 'world.rar', size: junk.length, user: 'a' });
  await assert.rejects(u.append(up.id, 0, body(junk), 'a'), (e) => e.status === 415 && /RAR archives aren't supported. Pack the world folder/.test(e.message));
  assert.deepEqual(u.list(), []);
  const dat = Buffer.concat([Buffer.from([0x0a, 0x00, 0x00]), Buffer.alloc(600)]);
  const up2 = u.create({ name: 'level.dat', size: dat.length, user: 'a' });
  await assert.rejects(u.append(up2.id, 0, body(dat), 'a'), /single level.dat/);
});

test('space, open uploads and old leftovers', async () => {
  const u = make();
  u.free = () => 5 * 1024 ** 3;
  assert.throws(() => u.create({ name: 'big.zip', size: 4.5 * 1024 ** 3, user: 'a' }), (e) => e.status === 507 && /Not enough disk space/.test(e.message));
  const ids = [1, 2, 3, 4].map(() => u.create({ name: 'w.zip', size: 100, user: 'a' }).id);
  assert.throws(() => u.create({ name: 'w.zip', size: 100, user: 'a' }), (e) => e.status === 409);
  const old = new Date(Date.now() - 2 * 86400 * 1000);
  for (const ext of ['json', 'part']) fs.utimesSync(path.join(u.dir, `${ids[0]}.${ext}`), old, old);
  fs.writeFileSync(path.join(u.dir, `${'9'.repeat(32)}.part`), 'orphan');
  u.prune();
  assert.deepEqual(u.list().sort(), ids.slice(1).sort());
  assert.ok(!fs.existsSync(path.join(u.dir, `${'9'.repeat(32)}.part`)));
});

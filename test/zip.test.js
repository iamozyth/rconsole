'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { readEntry } = require('../lib/zip');
const { parseManifest } = require('../lib/plugins');

// Minimal zip writer for fixtures.
function zip(files, { deflate = true } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = deflate ? zlib.deflateRawSync(data) : data;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, comp);
    centrals.push(central, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const YML = `name: SquareMap
version: '1.3.4'
main: xyz.jpenilla.squaremap.paper.SquaremapPaperBootstrap
description: "A minimalistic map"  # comment
authors: [jmp, BillyGalbreath]
depend:
  - Vault
`;

test('reads deflated and stored entries', () => {
  for (const deflate of [true, false]) {
    const jar = zip({ 'META-INF/MANIFEST.MF': 'x', 'plugin.yml': YML }, { deflate });
    assert.equal(readEntry(jar, 'plugin.yml').toString(), YML);
    assert.equal(readEntry(jar, 'missing.yml'), null);
  }
});

test('rejects non-zips', () => {
  assert.throws(() => readEntry(Buffer.from('not a zip at all, definitely not'), 'plugin.yml'), /Not a zip/);
});

test('parses plugin manifests', () => {
  const m = parseManifest(YML);
  assert.equal(m.name, 'SquareMap');
  assert.equal(m.version, '1.3.4');
  assert.equal(m.description, 'A minimalistic map');
  assert.deepEqual(m.authors, ['jmp', 'BillyGalbreath']);
  assert.deepEqual(m.depend, ['Vault']);
});

module.exports = { zip };

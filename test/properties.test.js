'use strict';
const test = require('node:test');
const assert = require('node:assert');
const p = require('../lib/properties');

const SAMPLE = `#Minecraft server properties
#Sun Oct 11 22:32:54 CEST 2026
level-name=world
level-type=minecraft\\:normal
motd=A \\u00A7aGreen\\u00A7r server
rcon.password=s3cr\\=t
white-list=true
`;

test('parses escapes and keeps unknown lines', () => {
  const doc = p.parse(SAMPLE);
  const o = p.toObject(doc);
  assert.equal(o['level-type'], 'minecraft:normal');
  assert.equal(o.motd, 'A §aGreen§r server');
  assert.equal(o['rcon.password'], 's3cr=t');
  assert.equal(p.stringify(doc), SAMPLE);
});

test('set rewrites only changed lines and appends new keys', () => {
  const doc = p.set(p.parse(SAMPLE), { 'level-name': 'creative', 'level-type': 'minecraft:flat', 'white-list': 'true', 'level-seed': '-123' });
  const text = p.stringify(doc);
  assert.match(text, /^level-name=creative$/m);
  assert.match(text, /^level-type=minecraft\\:flat$/m);
  assert.match(text, /^level-seed=-123$/m);
  assert.match(text, /^#Sun Oct 11/m);
  assert.equal(p.toObject(p.parse(text))['level-type'], 'minecraft:flat');
});

test('escapes newline and leading space so values cannot inject keys', () => {
  const doc = p.set(p.parse(''), { motd: ' hi\nenable-rcon=false' });
  const o = p.toObject(p.parse(p.stringify(doc)));
  assert.equal(o.motd, ' hi\nenable-rcon=false');
  assert.equal(o['enable-rcon'], undefined);
});

test('line continuation', () => {
  assert.equal(p.toObject(p.parse('a=one \\\n   two\n')).a, 'one two');
});

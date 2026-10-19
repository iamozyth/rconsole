'use strict';
// velocity.toml edits for proxies and the servers behind them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const velocity = require('../lib/velocity');

// Velocity's own default-velocity.toml (config-version 2.8).
const DEFAULTS = fs.readFileSync(path.join(__dirname, 'fixtures', 'default-velocity.toml'), 'utf8');
const servers = (toml) => toml.split('[servers]')[1].split('[forced-hosts]')[0];

test('configure: port, modern forwarding, no example servers or forced hosts', () => {
  const toml = velocity.configure(DEFAULTS, 25577);
  assert.match(toml, /^bind = "0\.0\.0\.0:25577"$/m);
  assert.match(toml, /^player-info-forwarding-mode = "MODERN"$/m);
  assert.doesNotMatch(toml, /lobby|factions|minigames/);
  assert.match(servers(toml), /^try = \[\]$/m);
  // Everything else and the comments stay as Velocity wrote them.
  assert.match(toml, /^\[advanced\]$/m);
  assert.match(toml, /^compression-threshold = 256$/m);
  assert.match(toml, /^# Configure your servers here/m);
});

test('addServer and removeServer keep a try list players can land on', () => {
  let toml = velocity.configure(DEFAULTS, 25577);
  toml = velocity.addServer(toml, 'survival', 25565);
  toml = velocity.addServer(toml, 'creative', 25566);
  assert.match(servers(toml), /^survival = "127\.0\.0\.1:25565"\ncreative = "127\.0\.0\.1:25566"$/m);
  assert.match(servers(toml), /^try = \["survival"\]$/m);
  // Adding again updates the port instead of a duplicate.
  toml = velocity.addServer(toml, 'creative', 25567);
  assert.strictEqual(servers(toml).match(/^creative =/gm).length, 1);
  assert.match(servers(toml), /^creative = "127\.0\.0\.1:25567"$/m);
  toml = velocity.removeServer(toml, 'survival');
  assert.doesNotMatch(servers(toml), /survival/);
  assert.match(servers(toml), /^try = \["creative"\]$/m);
});

test('addServer turns on modern forwarding in an older proxy config', () => {
  const toml = velocity.addServer(DEFAULTS, 'survival', 25565);
  assert.match(toml, /^player-info-forwarding-mode = "MODERN"$/m);
  assert.match(servers(toml), /^survival = "127\.0\.0\.1:25565"$/m);
  // A try list that already has servers is left alone.
  assert.match(servers(toml), /"lobby"/);
});

test('paperGlobal: only a plain secret goes into the YAML', () => {
  assert.match(velocity.paperGlobal('abcdefghijklmnopqrstuvwx'), /^ {4}secret: 'abcdefghijklmnopqrstuvwx'$/m);
  assert.match(velocity.paperGlobal('abcdefghijklmnopqrstuvwx'), /^ {4}enabled: true$/m);
  assert.throws(() => velocity.paperGlobal("x'\nproxies: evil"), /forwarding\.secret/);
  assert.throws(() => velocity.paperGlobal('short'), /forwarding\.secret/);
});

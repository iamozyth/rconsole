'use strict';
// Which server rconsole works on, and what changes in its config.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const active = require('../lib/active');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-active-'));
  const sv = path.join(root, 'servers');
  const state = path.join(root, 'state');
  fs.mkdirSync(state);
  const add = (id, distribution = 'paper', port = 25565) => {
    fs.mkdirSync(path.join(sv, id), { recursive: true });
    fs.writeFileSync(path.join(sv, id, 'instance.json'), JSON.stringify({ id, distribution, version: '26.3', java: 25, memoryMb: 1024, port, launch: { type: 'jar', path: `${id}.jar` } }));
    fs.writeFileSync(path.join(sv, id, 'server.properties'), `enable-rcon=true\nrcon.port=${port + 10}\nrcon.password=pw-${id}\n`);
  };
  return { sv, state, add };
}

test('no servers: nothing is active', () => {
  const { sv, state } = setup();
  assert.strictEqual(active.pick({ serversDir: sv, stateDir: state }), null);
});

test('the first game server is active until one is chosen; proxies are skipped', () => {
  const { sv, state, add } = setup();
  add('aproxy', 'velocity', 25577);
  add('survival');
  add('creative', 'paper', 25566);
  assert.strictEqual(active.pick({ serversDir: sv, stateDir: state }).id, 'creative');
  active.setActive(state, 'survival');
  assert.strictEqual(active.pick({ serversDir: sv, stateDir: state }).id, 'survival');
});

test('overrides point every view at the active server', () => {
  const { sv, state, add } = setup();
  add('survival');
  const o = active.overrides(sv, active.pick({ serversDir: sv, stateDir: state }));
  assert.deepStrictEqual(o, {
    activeServer: 'survival', mcDir: path.join(sv, 'survival'), mcService: 'rconsole-mc@survival.service',
    mcJar: 'survival.jar', rconHost: '127.0.0.1', rconPort: 25575, rconPassword: 'pw-survival',
  });
});

test('setActive refuses invalid ids', () => {
  assert.throws(() => active.setActive(setup().state, '../x'), /Invalid/);
});

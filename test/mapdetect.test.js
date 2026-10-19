'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detect, validMapUrl } = require('../lib/mapdetect');

const write = (dir, file, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
};

test('finds BlueMap, squaremap and Dynmap with their port and bind address', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-map-'));
  assert.deepStrictEqual(detect(dir), []);
  write(dir, 'plugins/BlueMap/webserver.conf', '# BlueMap\nenabled: true\nwebroot: "bluemap/web"\nport: 8100\n');
  write(dir, 'plugins/squaremap/config.yml', 'settings:\n  internal-webserver:\n    bind: 127.0.0.1\n    port: 8090\n    enabled: true\n');
  write(dir, 'plugins/dynmap/configuration.txt', 'webserver-bindaddress: 0.0.0.0\nwebserver-port: 8123\n');
  const found = detect(dir);
  assert.deepStrictEqual(found.map((m) => [m.plugin, m.port, m.url, m.private]), [
    ['BlueMap', 8100, 'http://127.0.0.1:8100', false],
    ['squaremap', 8090, 'http://127.0.0.1:8090', true],
    ['Dynmap', 8123, 'http://127.0.0.1:8123', false],
  ]);
  write(dir, 'plugins/BlueMap/webserver.conf', 'enabled: false\nport: 8100\n');
  assert.ok(!detect(dir).some((m) => m.plugin === 'BlueMap'));
});

test('only maps on this machine can be chosen', () => {
  assert.ok(validMapUrl('http://127.0.0.1:8100'));
  assert.ok(validMapUrl('http://localhost:8080/map'));
  for (const bad of ['http://10.0.0.5:8100', 'https://127.0.0.1:8100', 'http://127.0.0.1', 'http://127.0.0.1:99999', 'http://127.0.0.1:8100@evil', 'file:///etc/passwd']) assert.ok(!validMapUrl(bad), bad);
});

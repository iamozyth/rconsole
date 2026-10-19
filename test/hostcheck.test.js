'use strict';
// lib/hostcheck.js: memory and RCON conditions shown under Problems.
const test = require('node:test');
const assert = require('node:assert');
const { check, wildcardListeners } = require('../lib/hostcheck');

const GB = 1024 ** 3;
const mem = (o) => ({ total: 6 * GB, available: 3 * GB, swapTotal: 0, swapFree: 0, ...o });
const TCP = `  sl  local_address rem_address   st
   0: 00000000:6440 00000000:0000 0A 00000000:00000000 00:00000000 00000000   997        0 1 1
   1: 0100007F:6441 00000000:0000 0A 00000000:00000000 00:00000000 00000000   997        0 2 1
   2: 00000000:1F90 00000000:0000 01 00000000:00000000 00:00000000 00000000   997        0 3 1`;
const TCP6 = `  sl  local_address rem_address   st
   0: 00000000000000000000000000000000:63DD 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 997 0 4 1`;

test('wildcardListeners: listening on every address only, IPv4 and IPv6', () => {
  // 0x6440 = 25664 on 0.0.0.0; 0x6441 on 127.0.0.1; 0x1F90 not listening; 0x63DD = 25565 on ::.
  assert.deepStrictEqual([...wildcardListeners(TCP, TCP6)].sort(), [25565, 25664]);
});

test('memory: swapping, or almost nothing left', () => {
  assert.deepStrictEqual(check({ mem: mem(), listening: new Set() }), []);
  assert.match(check({ mem: mem({ swapTotal: 2 * GB, swapFree: GB }), listening: new Set() })[0].title, /swapping/);
  const low = check({ mem: mem({ available: 600 * 1024 ** 2 / 2 }), listening: new Set() });
  assert.match(low[0].title, /Almost no memory/);
  assert.match(low[0].message, /no swap/);
});

test('RCON: open on every address and not closed by the firewall', () => {
  const rcon = [{ name: 'survival', port: 25664 }, { name: 'creative', port: 25665 }];
  const listening = new Set([25664, 25665]);
  const none = check({ mem: mem(), rcon, listening, firewall: null });
  assert.strictEqual(none.length, 1);
  assert.match(none[0].message, /survival \(port 25664\), creative \(port 25665\) accept RCON/);
  assert.strictEqual(none[0].severity, 'warning');
  assert.deepStrictEqual(check({ mem: mem(), rcon, listening, firewall: { firewall: 'on', closed: [25664, 25665] } }), []);
  assert.match(check({ mem: mem(), rcon, listening, firewall: { firewall: 'off', closed: [] } })[0].message, /RCON_FIREWALL is off/);
  assert.match(check({ mem: mem(), rcon, listening: new Set([25664]), firewall: { firewall: 'on', closed: [25665] } })[0].message, /^survival \(port 25664\) accepts/);
});

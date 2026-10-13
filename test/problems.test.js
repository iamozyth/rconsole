'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Problems, classify, pluginOf } = require('../lib/problems');
const { parseLine } = require('../lib/logfiles');

const LOG = `[10:00:00] [Server thread/INFO]: Starting minecraft server version 26.3
[10:00:05] [Server thread/ERROR]: Error occurred while enabling BrokenPlugin v1.2.0 (Is it up to date?)
java.lang.NoClassDefFoundError: org/bukkit/craftbukkit/v1_20_R1/CraftServer
	at com.example.broken.BrokenPlugin.onEnable(BrokenPlugin.java:42) ~[BrokenPlugin-1.2.0.jar:?]
[10:05:00] [Server thread/WARN]: Can't keep up! Is the server overloaded? Running 5012ms or 100 ticks behind
[10:06:00] [Server thread/WARN]: Can't keep up! Is the server overloaded? Running 2400ms or 48 ticks behind
[10:07:00] [Server thread/ERROR]: Could not pass event PlayerJoinEvent to Essentials v2.20.1
java.lang.NullPointerException: Cannot invoke "String.length()" because "name" is null
	at com.earth2me.essentials.Essentials.onJoin(Essentials.java:100)
[10:08:00] [Server thread/ERROR]: Could not pass event PlayerJoinEvent to Essentials v2.20.1
java.lang.NullPointerException: Cannot invoke "String.length()" because "name" is null
[10:09:00] [Server thread/INFO]: Steve joined the game
[10:10:00] [Server thread/ERROR]: [Votifier] Unable to bind to port 8192
[10:20:00] [Server Watchdog/ERROR]: The server has stopped responding! This is (probably) not a Paper bug.
[10:21:00] [Server thread/ERROR]: java.lang.OutOfMemoryError: Java heap space
[10:22:00] [Server thread/ERROR]: This crash report has been saved to: /srv/minecraft/crash-reports/crash-2026-10-13_10.22.00-server.txt
`;

test('problems: lines are classified by kind and plugin', () => {
  const c = (line) => classify(parseLine(line));
  assert.deepStrictEqual(
    [c('[10:00:05] [Server thread/ERROR]: Error occurred while enabling BrokenPlugin v1.2.0 (Is it up to date?)')].map((x) => [x.kind, x.plugin]),
    [['plugin', 'BrokenPlugin']]
  );
  assert.strictEqual(c("[10:05:00] [Server thread/WARN]: Can't keep up! Is the server overloaded? Running 5012ms or 100 ticks behind").behindMs, 5012);
  assert.strictEqual(c('[10:21:00] [Server thread/ERROR]: java.lang.OutOfMemoryError: Java heap space').kind, 'oom');
  assert.strictEqual(c('[10:20:00] [Server Watchdog/ERROR]: The server has stopped responding! This is (probably) not a Paper bug.').kind, 'hang');
  assert.strictEqual(c('[10:09:00] [Server thread/INFO]: Steve joined the game'), null);
  assert.strictEqual(c('[10:09:00] [Server thread/WARN]: Something odd'), null);
  assert.strictEqual(pluginOf("Could not load 'plugins/Foo-1.0.jar' in folder 'plugins'"), 'Foo-1.0');
  assert.strictEqual(pluginOf('[Votifier] Unable to bind to port 8192'), 'Votifier');
  assert.strictEqual(pluginOf('[Not Secure] <Steve> hi'), null);
});

test('problems: a scan groups repeats, keeps the exception line, sorts by severity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-problems-'));
  fs.mkdirSync(path.join(dir, 'logs'));
  fs.writeFileSync(path.join(dir, 'logs', 'latest.log'), LOG);
  const p = new Problems({ mcDir: dir, stateDir: dir });
  const { groups } = await p.scan({ days: 7 });
  const byKind = (k) => groups.filter((g) => g.kind === k);
  assert.deepStrictEqual(groups.slice(0, 3).map((g) => g.severity), ['critical', 'critical', 'critical']);
  const ess = byKind('plugin').find((g) => g.plugin === 'Essentials');
  assert.strictEqual(ess.count, 2);
  assert.match(ess.detail, /^java\.lang\.NullPointerException/);
  assert.match(byKind('plugin').find((g) => g.plugin === 'BrokenPlugin').detail, /NoClassDefFoundError/);
  assert.strictEqual(byKind('lag')[0].count, 2);
  assert.strictEqual(byKind('lag')[0].maxBehindMs, 5012);
  assert.strictEqual(byKind('error')[0].plugin, 'Votifier');
  assert.ok(groups.every((g) => g.unseen));
  p.markSeen();
  assert.ok((await p.scan({ days: 7 })).groups.every((g) => !g.unseen));
  assert.deepStrictEqual(await p.summary(), { unseen: 0, critical: 0 });
});

test('problems: live lines alert once per new group, with the exception line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-problems-'));
  const got = [];
  const p = new Problems({ mcDir: dir, stateDir: dir, onProblem: (g) => got.push(g) });
  p.onLogLine('[10:07:00] [Server thread/ERROR]: Could not pass event PlayerJoinEvent to Essentials v2.20.1'); // before ready: ignored
  p.ready = true;
  p.onLogLine('[10:07:00] [Server thread/ERROR]: Could not pass event PlayerJoinEvent to Essentials v2.20.1');
  p.onLogLine('java.lang.NullPointerException: boom');
  p.onLogLine('[10:08:00] [Server thread/ERROR]: Could not pass event PlayerJoinEvent to Essentials v2.20.1'); // same group: no alert
  p.onLogLine("[10:09:00] [Server thread/WARN]: Can't keep up! Is the server overloaded? Running 3000ms or 60 ticks behind"); // lag: TPS alert covers it
  p.record({ title: 'Server stopped unexpectedly', message: 'systemd: exit-code' });
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].plugin, 'Essentials');
  assert.strictEqual(got[0].detail, 'java.lang.NullPointerException: boom');
  assert.strictEqual(got[1].title, 'Server stopped unexpectedly');
  assert.strictEqual((await p.scan({ days: 1 })).groups[0].message, 'systemd: exit-code');
});

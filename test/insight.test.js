'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { parseLine, listFiles, scanFile } = require('../lib/logfiles');
const { PlayerHistory, summarize } = require('../lib/players');
const { searchLogs } = require('../lib/logsearch');
const { average } = require('../lib/metrics');
const { Audit, summarize: auditSummary } = require('../lib/audit');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-insight-'));

test('parseLine handles file and console formats', () => {
  assert.deepStrictEqual(parseLine('[12:00:05] [Server thread/INFO]: Steve joined the game'), { secs: 43205, thread: 'Server thread', level: 'INFO', msg: 'Steve joined the game' });
  assert.deepStrictEqual(parseLine('[01:02:03 WARN]: Can\'t keep up!'), { secs: 3723, thread: null, level: 'WARN', msg: 'Can\'t keep up!' });
  assert.strictEqual(parseLine('\tat java.base/Thread.run'), null);
});

function writeLogs(dir) {
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  // A run that crosses midnight; Alex never leaves before the server stops.
  const old = [
    '[23:50:00] [Server thread/INFO]: Starting minecraft server version 26.3',
    '[23:55:00] [User Authenticator #1/INFO]: UUID of player Steve is 069a79f4-44e9-4726-a5be-fca90e38aaf5',
    '[23:55:00] [Server thread/INFO]: Steve[/10.0.0.5:51234] logged in with entity id 1 at (0, 64, 0)',
    '[23:55:00] [Server thread/INFO]: Steve joined the game',
    '[00:05:00] [Server thread/INFO]: <Steve> Bob joined the game',
    '[00:10:00] [Server thread/INFO]: Steve left the game',
    '[00:20:00] [Server thread/INFO]: Alex joined the game',
    '[00:30:00] [Server thread/WARN]: Can\'t keep up! Is the server overloaded?',
    '[00:50:00] [Server thread/INFO]: Stopping server',
  ].join('\n');
  fs.writeFileSync(path.join(logs, '2026-10-01-1.log.gz'), zlib.gzipSync(old));
  fs.writeFileSync(path.join(logs, 'latest.log'), [
    '[10:00:00] [Server thread/INFO]: Starting minecraft server version 26.3',
    '[10:01:00] [Server thread/INFO]: Steve joined the game',
    '[10:02:00] [Server thread/ERROR]: Could not pass event to Steve plugin',
  ].join('\n'));
  const now = new Date();
  fs.utimesSync(path.join(logs, 'latest.log'), now, new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 2, 30));
  return logs;
}

test('scanFile dates rotated logs from the file name and counts midnights', async () => {
  const logs = writeLogs(tmp());
  const files = await listFiles(logs);
  assert.deepStrictEqual(files.map((f) => f.name), ['2026-10-01-1.log.gz', 'latest.log']);
  const r = await scanFile(files[0], (p) => (p.msg.includes('left') ? p.msg : undefined));
  assert.strictEqual(r.items.length, 1);
  assert.strictEqual(new Date(r.items[0].t).toString(), new Date(2026, 9, 2, 0, 10).toString());
  assert.strictEqual(new Date(r.first).getDate(), 1);
  assert.strictEqual(new Date(r.last).getDate(), 2);
});

test('player history builds sessions, ignores chat and keeps open sessions online', async () => {
  const dir = tmp();
  writeLogs(dir);
  const h = new PlayerHistory({ mcDir: dir, stateDir: dir });
  const { players, daily } = await h.history();
  const steve = players.find((p) => p.name === 'Steve');
  const alex = players.find((p) => p.name === 'Alex');
  assert.ok(!players.find((p) => p.name === 'Bob'), 'chat line is not a join');
  assert.strictEqual(steve.uuid, '069a79f4-44e9-4726-a5be-fca90e38aaf5');
  assert.strictEqual(steve.ip, '10.0.0.5');
  assert.strictEqual(steve.sessions, 2);
  assert.strictEqual(steve.online, true);
  assert.strictEqual(alex.playtime, 30 * 60 * 1000, 'closed at Stopping server');
  assert.ok(daily.length >= 1);
  // Rotated logs are cached and survive deletion.
  fs.rmSync(path.join(dir, 'logs', '2026-10-01-1.log.gz'));
  const again = await new PlayerHistory({ mcDir: dir, stateDir: dir }).history();
  assert.ok(again.players.find((p) => p.name === 'Alex'));
});

test('summarize splits playtime across days', () => {
  const t0 = new Date(2026, 0, 1, 23, 0).getTime();
  const { daily } = summarize([{ events: [{ t: t0, type: 'join', name: 'A' }, { t: t0 + 2 * 3600e3, type: 'leave', name: 'A' }] }], new Date(2026, 0, 5).getTime());
  assert.deepStrictEqual(daily.map((d) => [d.day, d.playtime / 3600e3]), [['2026-01-01', 1], ['2026-01-02', 1]]);
});

test('log search filters by text, player and level, newest first', async () => {
  const dir = tmp();
  writeLogs(dir);
  const r = await searchLogs(dir, { player: 'steve' });
  assert.ok(r.results.length >= 4);
  assert.match(r.results[0].msg, /Could not pass event/);
  assert.ok(r.results.every((x, i, a) => i === 0 || a[i - 1].t >= x.t));
  const warn = await searchLogs(dir, { level: 'WARN' });
  assert.deepStrictEqual(warn.results.map((x) => x.level), ['ERROR', 'WARN']);
  await assert.rejects(searchLogs(dir, {}), /search term/);
});

test('metrics average ignores gaps and keeps the player peak', () => {
  const a = average([{ tps: 20, players: 1, cpu: 0.2 }, { tps: 18, players: 3, cpu: null }], 0);
  assert.strictEqual(a.tps, 19);
  assert.strictEqual(a.players, 3);
  assert.strictEqual(a.cpu, 0.2);
  assert.strictEqual(a.mem, null);
});

test('audit drops secrets, filters and returns newest first', async () => {
  assert.deepStrictEqual(auditSummary({ password: 'x', code: '1', name: 'w' }), { name: 'w' });
  const dir = tmp();
  const a = new Audit({ stateDir: dir });
  await a.record({ user: 'm', action: 'command', target: '/say hi' });
  await a.record({ user: 'k', action: 'world delete', target: 'old', ok: false, error: 'busy' });
  const all = await a.query();
  assert.deepStrictEqual(all.entries.map((e) => e.user), ['k', 'm']);
  assert.deepStrictEqual(all.actions, ['command', 'world']);
  assert.strictEqual((await a.query({ failed: true })).entries.length, 1);
  assert.strictEqual((await a.query({ action: 'world' })).entries[0].target, 'old');
});

test('player history reads Paper 26 "System chat:" joins', () => {
  const { pickEvent } = require('../lib/players');
  const ev = (l) => pickEvent(parseLine(l));
  assert.deepStrictEqual(ev('[12:05:08] [Server thread/INFO]: System chat: NXZET joined the game'), { type: 'join', name: 'NXZET', extra: undefined });
  assert.deepStrictEqual(ev('[12:05:38] [Server thread/INFO]: System chat: NXZET left the game'), { type: 'leave', name: 'NXZET', extra: undefined });
  assert.strictEqual(ev('[12:08:00] [Async Chat Thread - #0/INFO]: <NXZET> System chat: Bob joined the game'), undefined);
});

test('connection attempts: grouped by address, known players and LAN excluded', async () => {
  const dir = tmp();
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'latest.log'), [
    '[11:40:07] [Server thread/INFO]: Starting minecraft server version 26.3',
    '[12:05:07] [User Authenticator #0/INFO]: UUID of player NXZET is d6837fe0-a88e-405d-ae5a-68a96f883729',
    '[12:05:08] [Server thread/INFO]: System chat: NXZET joined the game',
    '[12:05:08] [Server thread/INFO]: NXZET[/10.10.5.20:52752] logged in with entity id 61 at ([minecraft:overworld]8.0, 68.0, 5.3)',
    '[12:05:38] [Server thread/INFO]: NXZET lost connection: Disconnected',
    '[12:07:46] [Server thread/INFO]: FishNet (/176.65.149.198:61000) lost connection: Disconnected',
    '[12:09:00] [Server thread/INFO]: Admin (/176.65.149.198:61002) lost connection: You are not white-listed on this server!',
    '[12:10:00] [Server thread/INFO]: Friend (/10.10.5.21:5000) lost connection: Disconnected',
    '[12:11:00] [Server thread/INFO]: Late (/10.10.5.20:5001) lost connection: Disconnected',
  ].join('\n'));
  const { attempts, players } = await new PlayerHistory({ mcDir: dir, stateDir: dir }).history();
  assert.strictEqual(players.length, 1, 'attempts are not players');
  assert.deepStrictEqual(attempts.map((a) => [a.ip, a.count, a.names.sort().join(','), a.private]), [['10.10.5.21', 1, 'Friend', true], ['176.65.149.198', 2, 'Admin,FishNet', false]]);
  assert.match(attempts[1].reasons.join(), /white-listed/);
});

test('scanner tracker: live alerts only for unknown public addresses, never for the replayed log', () => {
  const { Scanners } = require('../lib/scanners');
  const seen = [];
  const s = new Scanners({ onAttempt: (a) => seen.push(a.ip) });
  s.onLogLine('[12:07:46] [Server thread/INFO]: Old (/9.9.9.9:1) lost connection: Disconnected'); // before seeding: replay
  s.seed({ players: [{ ip: '81.2.3.4' }], attempts: [] });
  s.onLogLine('[12:07:46] [Server thread/INFO]: FishNet (/176.65.149.198:61000) lost connection: Disconnected');
  s.onLogLine('[12:07:47] [Server thread/INFO]: Me (/81.2.3.4:2) lost connection: Disconnected'); // known player address
  s.onLogLine('[12:07:48] [Server thread/INFO]: Lan (/192.168.1.9:2) lost connection: Disconnected');
  assert.deepStrictEqual(seen, ['176.65.149.198']);
  assert.deepStrictEqual([s.summary().addresses, s.summary().attempts], [1, 1]);
});

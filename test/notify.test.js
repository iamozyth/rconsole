'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Notify } = require('../lib/notify');
const prom = require('../lib/prom');

function ntfyServer() {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      got.push({ ...JSON.parse(body || '{}'), auth: req.headers.authorization, path: req.url });
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, got, url: `http://127.0.0.1:${server.address().port}/alerts` })));
}
const settle = () => new Promise((r) => setTimeout(r, 80));

test('notify: down/up, lag after N minutes, rate limits, token and update dedup', async () => {
  const { server, got, url } = await ntfyServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-notify-'));
  const n = new Notify({ stateDir: dir });
  assert.throws(() => n.update({ url: 'not a url' }), /topic URL/);
  n.update({ url, token: 'tk_secret', tpsBelow: 15, tpsMinutes: 1 });
  assert.strictEqual(n.view().hasToken, true);
  assert.ok(!JSON.stringify(n.view()).includes('tk_secret'));
  const ctx = { stats: { cache: { host: { disk: { total: 100, available: 50 } } } }, ops: { state: {} }, countdown: { remaining: null }, backups: { state: {} } };

  n.onSample({ up: 1, tps: 20 }, ctx);
  n.onSample({ up: 0, tps: null }, ctx);
  n.onSample({ up: 1, tps: 20 }, ctx);
  await settle();
  assert.deepStrictEqual(got.map((g) => g.title), ['Minecraft server is down', 'Minecraft server is back up']);
  assert.strictEqual(got[0].auth, 'Bearer tk_secret');
  assert.strictEqual(got[0].priority, 5);
  assert.strictEqual(got[0].path, '/');
  assert.strictEqual(got[0].topic, 'alerts');
  assert.strictEqual(got[0].sequence_id, 'server-state');
  assert.strictEqual(got[1].sequence_id, 'server-state', 'back up replaces the down alert');

  // A second crash within 10 minutes is rate limited.
  n.onSample({ up: 0 }, ctx);
  await settle();
  assert.strictEqual(got.length, 2);

  n.onSample({ up: 1, tps: 12, players: 3 }, ctx);
  n.onSample({ up: 1, tps: 11, players: 3 }, ctx); // 2 samples x 30 s = 1 minute
  await settle();
  assert.strictEqual(got[2].title, 'Server is lagging');

  ctx.stats.cache.host.disk.available = 5;
  n.onSample({ up: 1, tps: 20 }, ctx);
  await settle();
  assert.ok(got.some((g) => g.title === 'Disk almost full'));
  assert.ok(got.some((g) => g.title === 'Lag is over'));

  n.onAudit({ ok: false, action: 'login', error: 'locked out', user: 'x', ip: '1.2.3.4' });
  n.onAudit({ ok: true, action: 'login', user: 'x' });
  await settle();
  assert.ok(got.some((g) => g.title === 'Sign-in locked out'));

  const deps = { updates: { overview: async () => ({ newerBuilds: [{ id: 200 }] }) }, plugins: { list: async () => ({ plugins: [] }) }, selfUpdate: { overview: async () => ({}) } };
  await n.checkUpdates(deps);
  const before = got.length;
  await n.checkUpdates(deps);
  assert.strictEqual(got.length, before, 'same build is announced once');
  assert.match(got[before - 1].message, /\*\*Paper\*\* build 200/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'notify.json'), 'utf8')).seen['paper-200']);
  server.close();
});

test('prometheus output has HELP/TYPE and skips unknown values', async () => {
  const text = await prom.render({
    metrics: { latest: () => ({ up: 1, tps: 19.5, rss: 1024, pcpu: null }) },
    stats: { cache: { rcon: { ok: true }, game: { tps: 19.9, players: { online: 2, max: 20 } }, host: { cpu: 0.2, mem: { total: 8, available: 4 }, disk: null } } },
    power: { state: async () => ({ since: '2026-10-11T10:00:00Z' }) },
    backups: { list: async () => [{ size: 10, created: '2026-10-11T09:00:00Z' }], state: { lastError: null } },
    maintenance: { state: () => ({ enabled: false }) },
    selfUpdate: { summary: () => ({ available: 0 }) },
    updates: {},
  });
  assert.match(text, /^# HELP minecraft_tps .*\n# TYPE minecraft_tps gauge\nminecraft_tps 19.9$/m);
  assert.match(text, /^minecraft_players_online 2$/m);
  assert.match(text, /^minecraft_backup_last_timestamp_seconds 1791709200$/m);
  assert.doesNotMatch(text, /minecraft_process_cpu_ratio/);
  assert.doesNotMatch(text, /host_disk/);
});

test('notify: joins and leaves come from the polled player list', async () => {
  const { server, got, url } = await ntfyServer();
  const n = new Notify({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-notify-')) });
  n.update({ url, events: { players: true } });
  const ctx = (players) => ({ stats: { cache: { game: { players: { players } } } }, ops: { state: {} }, countdown: { remaining: null }, backups: { state: {} } });
  n.onSample({ up: 1, tps: 20 }, ctx(['Alex'])); // baseline: nobody is announced
  n.onSample({ up: 1, tps: 20 }, ctx(['Alex', 'Steve']));
  n.onSample({ up: 1, tps: 20 }, ctx(['Steve']));
  n.onSample({ up: 0 }, ctx(undefined)); // RCON down
  n.onSample({ up: 1, tps: 20 }, ctx(['Steve', 'Kai'])); // new baseline, no flood
  await settle();
  assert.deepStrictEqual(got.map((g) => g.title).filter((t) => /joined|left/.test(t)), ['Steve joined', 'Alex left']);
  assert.strictEqual(got.find((g) => g.title === 'Steve joined').priority, 3);
  server.close();
});

test('notify: Paper 26 "System chat:" join lines alert at once, without duplicates from the list', async () => {
  const { server, got, url } = await ntfyServer();
  const n = new Notify({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-notify-')) });
  n.update({ url, events: { players: true } });
  const ctx = (players) => ({ stats: { cache: { game: { players: { players } } } }, ops: { state: {} }, countdown: { remaining: null }, backups: { state: {} } });
  n.onSample({ up: 1, tps: 20 }, ctx([]));
  n.onLogLine('[12:05:07] [User Authenticator #0/INFO]: UUID of player NXZET is d6837fe0-a88e-405d-ae5a-68a96f883729');
  n.onLogLine('[12:05:08] [Server thread/INFO]: System chat: NXZET joined the game');
  n.onSample({ up: 1, tps: 20 }, ctx(['NXZET'])); // list agrees: no second alert
  n.onLogLine('[12:05:38] [Server thread/INFO]: NXZET lost connection: Disconnected');
  n.onLogLine('[12:05:38] [Server thread/INFO]: System chat: NXZET left the game');
  n.onLogLine('[12:07:46] [Server thread/INFO]: FishNet (/176.65.149.198:61000) lost connection: Disconnected');
  n.onLogLine('[12:08:00] [Async Chat Thread - #0/INFO]: <NXZET> Bob joined the game');
  n.onSample({ up: 1, tps: 20 }, ctx([]));
  await settle();
  assert.deepStrictEqual(got.map((g) => g.title), ['NXZET joined', 'NXZET left']);
  server.close();
});


test('notify: click target, icon, buttons, quiet hours and one-tap actions', async () => {
  const { server, got, url } = await ntfyServer();
  const n = new Notify({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-notify-')) });
  assert.throws(() => n.update({ publicUrl: 'javascript:alert(1)' }), /rconsole URL/);
  n.update({ url, publicUrl: 'https://rconsole.example.com/', events: { scanner: true }, oneTap: true });
  let banned = null;
  n.handlers = { ban: async (ip) => { banned = ip; return 'ok'; } };
  n.onScanner({ ip: '176.65.149.198', name: 'FishNet', reason: 'Disconnected' });
  n.onScanner({ ip: '176.65.149.198', name: 'Admin', reason: 'Disconnected' }); // same address: no new alert
  n.onScanner({ ip: '45.83.64.12', name: null, reason: 'Internal Exception' });
  await settle();
  assert.deepStrictEqual(got.map((g) => g.title), ['Unknown connection from 176.65.149.198', '2 unknown addresses today']);
  const last = got[1];
  assert.strictEqual(last.click, 'https://rconsole.example.com/#players/security');
  assert.strictEqual(last.icon, 'https://rconsole.example.com/notify-icon.png');
  assert.strictEqual(last.markdown, true);
  assert.match(last.sequence_id, /^scanners-\d{4}-\d{2}-\d{2}$/);
  assert.deepStrictEqual(last.actions.map((a) => a.action), ['http', 'copy', 'view']);
  const token = last.actions[0].url.split('/').pop();
  assert.deepStrictEqual((await n.act(token)).arg, '45.83.64.12');
  assert.strictEqual(banned, '45.83.64.12');
  await assert.rejects(n.act(token), /expired or was already used/);

  // One-tap off: no http buttons, and old tokens stop working.
  const token2 = got[0].actions[0].url.split('/').pop();
  n.update({ oneTap: false });
  await assert.rejects(n.act(token2), /expired or was already used/);

  // Quiet hours lower everything but urgent alerts.
  n.update({ quiet: { enabled: true, from: '00:00', to: '23:59' }, events: { tps: true } });
  assert.ok(n.inQuietHours(new Date(2026, 0, 1, 12, 0)));
  assert.ok(!n.inQuietHours(new Date(2026, 0, 1, 23, 59, 30)));
  n.update({ quiet: { from: '22:00', to: '07:00' } });
  assert.ok(n.inQuietHours(new Date(2026, 0, 1, 23, 0)) && n.inQuietHours(new Date(2026, 0, 1, 6, 59)) && !n.inQuietHours(new Date(2026, 0, 1, 12, 0)));
  server.close();
});

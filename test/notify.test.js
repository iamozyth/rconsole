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
      got.push({ title: req.headers.title, priority: req.headers.priority, auth: req.headers.authorization, body });
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
  assert.strictEqual(got[0].priority, '5');

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
  assert.ok(got.some((g) => g.title === 'TPS recovered'));

  n.onAudit({ ok: false, action: 'login', error: 'locked out', user: 'x', ip: '1.2.3.4' });
  n.onAudit({ ok: true, action: 'login', user: 'x' });
  await settle();
  assert.ok(got.some((g) => g.title === 'Sign-in locked out'));

  const deps = { updates: { overview: async () => ({ newerBuilds: [{ id: 200 }] }) }, plugins: { list: async () => ({ plugins: [] }) }, selfUpdate: { overview: async () => ({}) } };
  await n.checkUpdates(deps);
  const before = got.length;
  await n.checkUpdates(deps);
  assert.strictEqual(got.length, before, 'same build is announced once');
  assert.match(got[before - 1].body, /Paper build 200/);
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

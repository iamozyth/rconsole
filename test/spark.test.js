'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Spark } = require('../lib/spark');

test('spark: detection, start over RCON, link picked up from the activity log', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-spark-'));
  const sent = [];
  const rcon = { send: async (c) => (sent.push(c), '') }; // spark answers asynchronously: empty reply
  const s = new Spark({ mcDir: dir, rcon, plugins: { list: async () => ({ plugins: [] }) } });
  assert.strictEqual((await s.status()).installed, false);
  await assert.rejects(s.start('profile'), /not installed/);

  fs.mkdirSync(path.join(dir, 'plugins/spark'), { recursive: true });
  const act = path.join(dir, 'plugins/spark/activity.json');
  fs.writeFileSync(act, JSON.stringify([{ user: { name: 'Console' }, time: Date.now() - 86400000, type: 'Profiler', data: { type: 'url', value: 'https://spark.lucko.me/old123' } }]));
  assert.strictEqual((await s.status()).installed, true);

  await s.start('profile', 30);
  assert.deepStrictEqual(sent, ['spark profiler start --timeout 30']);
  await assert.rejects(s.start('health'), /already running/);
  // spark finishes and records the upload
  fs.writeFileSync(act, JSON.stringify([
    { user: { name: 'Console' }, time: Date.now() - 86400000, type: 'Profiler', data: { type: 'url', value: 'https://spark.lucko.me/old123' } },
    { user: { name: 'Rcon' }, time: Date.now(), type: 'Profiler', data: { type: 'url', value: 'https://spark.lucko.me/new456' } },
  ]));
  const end = Date.now() + 5000;
  while (s.running && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  const st = await s.status();
  assert.strictEqual(st.running, null);
  assert.strictEqual(st.last.url, 'https://spark.lucko.me/new456');
  assert.deepStrictEqual(st.activity.map((a) => a.url), ['https://spark.lucko.me/new456', 'https://spark.lucko.me/old123']);
});

test('spark: a link in the RCON reply is used directly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-spark-'));
  fs.mkdirSync(path.join(dir, 'config/spark'), { recursive: true }); // Fabric/Forge location
  const s = new Spark({ mcDir: dir, rcon: { send: async () => 'Health report:\nhttps://spark.lucko.me/abc789' }, plugins: { list: async () => ({ plugins: [] }) } });
  await s.start('health');
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual((await s.status()).last.url, 'https://spark.lucko.me/abc789');
});

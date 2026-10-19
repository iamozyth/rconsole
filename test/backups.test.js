'use strict';
// lib/backups.js: autosave is paused around the archive and always resumed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Backups } = require('../lib/backups');

function setup(rconSend) {
  const sent = [];
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-backups-'));
  const backups = new Backups({
    rcon: { send: async (cmd) => (sent.push(cmd), rconSend(cmd)) },
    jobs: { run: async () => (sent.push('job'), { file: 'world-2026-10-19_20-00-00.tar.zst' }) },
    backupDir, keep: 0, log: () => {}, activeWorld: async () => 'world',
  });
  return { backups, sent };
}

test('save-off, flush, archive, save-on', async () => {
  const { backups, sent } = setup(async () => '');
  await backups.run();
  assert.deepStrictEqual(sent, ['save-off', 'save-all flush', 'job', 'save-on']);
});

test('save-on follows even when the reply to save-off is lost', async () => {
  // The server may have turned saving off before the connection dropped.
  const { backups, sent } = setup(async (cmd) => {
    if (cmd === 'save-off') throw new Error('RCON timeout');
    return '';
  });
  await backups.run();
  assert.deepStrictEqual(sent, ['save-off', 'job', 'save-on']);
});

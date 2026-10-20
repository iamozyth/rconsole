'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Scheduler, migrate, validate, leadSeconds, nextRun } = require('../lib/scheduler');

function fakeTarget(overrides = {}) {
  const calls = [];
  const t = {
    calls,
    send: async (cmd) => (calls.push(`send ${cmd}`), 'There are 0 of a max of 20 players online'),
    announce: async (text) => calls.push(`say ${text}`),
    countdown: {
      start: async (s, label, opts) => {
        calls.push(`countdown ${s} ${opts?.verb || 'restarting'}`);
        if (opts?.finish) await opts.finish();
      },
    },
    power: { state: async () => ({ active: 'inactive' }), run: async (a) => calls.push(`power ${a}`) },
    backup: async () => (calls.push('backup'), 'world-2026.tar.zst'),
    players: async () => 0,
    ...overrides,
  };
  return t;
}

function make({ target = fakeTarget(), kinds = { survival: 'server', proxy: 'proxy' }, tasks } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-sched-'));
  if (tasks) fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify(tasks));
  const audits = [];
  const s = new Scheduler({
    stateDir: dir,
    log: () => {},
    audit: (e) => audits.push(e),
    targets: { kind: (id) => kinds[id] || null, get: () => target },
    defaultServer: 'survival',
    sleepFn: async (ms) => target.calls.push(`wait ${ms / 1000}`),
  });
  return { s, target, audits, dir };
}

test('tasks from before 4.6 become a time trigger with one step, on the shown server', async () => {
  const { s } = make({
    tasks: [
      { id: 'a', type: 'restart', time: '04:00', days: [], warnMinutes: 5, enabled: true, name: '' },
      { id: 'b', type: 'command', time: '05:00', days: [1], command: 'say hi', enabled: false, name: 'Hi' },
    ],
  });
  await s.load();
  assert.deepEqual(s.tasks[0].trigger, { type: 'time', time: '04:00', days: [] });
  assert.deepEqual(s.tasks[0].steps, [{ type: 'restart', warnSeconds: 300 }]);
  assert.equal(s.tasks[0].server, 'survival');
  assert.deepEqual(s.tasks[1].steps, [{ type: 'command', command: 'say hi' }]);
  assert.equal(s.tasks[1].type, undefined);
  s.tasks.forEach((t) => s.disarm(t.id));
});

test('a chain runs its steps in order and records the result', async () => {
  const { s, target, audits } = make();
  await s.load();
  const task = await s.create({
    trigger: { type: 'time', time: '04:00' },
    steps: [
      { type: 'say', message: 'Backup and restart in 5 minutes' },
      { type: 'wait', seconds: 240 },
      { type: 'backup' },
      { type: 'restart', warnSeconds: 60 },
    ],
  });
  const result = await s.run(task.id, { user: 'masseo' });
  assert.deepEqual(target.calls, ['say Backup and restart in 5 minutes', 'wait 240', 'backup', 'countdown 60 restarting']);
  assert.equal(result, 'backup world-2026.tar.zst · restarted');
  assert.equal(audits.at(-1).ok, true);
  assert.equal(s.list()[0].running, null);
  s.disarm(task.id);
});

test('"only if nobody is online" ends the chain when players are on', async () => {
  const target = fakeTarget({ players: async () => 3 });
  const { s } = make({ target });
  await s.load();
  const task = await s.create({ trigger: { type: 'cron', cron: '0 */6 * * *' }, steps: [{ type: 'if-empty' }, { type: 'restart', warnSeconds: 0 }] });
  assert.equal(await s.run(task.id), 'skipped: 3 players online');
  assert.deepEqual(target.calls, []);
  s.disarm(task.id);
});

test('a failing step stops the chain and is reported', async () => {
  const target = fakeTarget({ backup: async () => { throw new Error('disk full'); } });
  const { s, audits } = make({ target });
  await s.load();
  const task = await s.create({ trigger: { type: 'time', time: '03:00' }, steps: [{ type: 'backup' }, { type: 'command', command: 'say done' }] });
  assert.equal(await s.run(task.id), 'error: disk full');
  assert.ok(!target.calls.includes('send say done'));
  assert.equal(audits.at(-1).ok, false);
  s.disarm(task.id);
});

test('validation: steps, triggers and what a proxy can do', () => {
  assert.throws(() => validate({ trigger: { type: 'time', time: '04:00' }, steps: [] }), /at least one step/);
  assert.throws(() => validate({ trigger: { type: 'time', time: '4:00' }, steps: [{ type: 'backup' }] }), /HH:MM/);
  assert.throws(() => validate({ trigger: { type: 'cron', cron: '61 * * * *' }, steps: [{ type: 'backup' }] }), /Cron/);
  assert.throws(() => validate({ trigger: { type: 'event', event: 'log', match: 'x' }, steps: [{ type: 'backup' }] }), /3 characters/);
  assert.throws(() => validate({ trigger: { type: 'time', time: '04:00' }, steps: [{ type: 'say', message: '' }] }), /Step 1/);
  assert.throws(() => validate({ trigger: { type: 'time', time: '04:00' }, steps: [{ type: 'backup' }] }, { kind: 'proxy' }), /proxy/);
  assert.throws(() => validate({ trigger: { type: 'event', event: 'empty' }, steps: [{ type: 'restart' }] }, { kind: 'proxy' }), /game servers/);
  const ok = validate({ trigger: { type: 'event', event: 'empty', minutes: 999999 }, steps: [{ type: 'wait', seconds: 1e9 }, { type: 'command', command: '/say\nhi' }] });
  assert.equal(ok.trigger.minutes, 1440);
  assert.equal(ok.trigger.cooldownMinutes, 10);
  assert.equal(ok.steps[0].seconds, 3600);
  assert.equal(ok.steps[1].command, 'say hi');
});

test('a restart first in a scheduled task starts early so it ends on time', () => {
  const task = migrate({ type: 'restart', time: '04:00', days: [], warnMinutes: 5 });
  assert.equal(leadSeconds(task), 300);
  assert.equal(leadSeconds({ ...task, trigger: { type: 'event', event: 'crash' } }), 0);
  const n = nextRun(task, new Date(2026, 9, 20, 3, 0));
  assert.equal(n.getHours(), 4);
  assert.equal(nextRun({ trigger: { type: 'cron', cron: '*/10 * * * *' } }, new Date(2026, 9, 20, 3, 1)).getMinutes(), 10);
});

test('unknown servers are refused', async () => {
  const { s } = make();
  await assert.rejects(s.create({ server: 'nope', trigger: { type: 'time', time: '04:00' }, steps: [{ type: 'backup' }] }), /No server named nope/);
});

test('events: start, crash (not when planned), cooldown', async () => {
  const { s, target } = make();
  await s.load();
  const onCrash = await s.create({ trigger: { type: 'event', event: 'crash', cooldownMinutes: 10 }, steps: [{ type: 'start' }] });
  const onStart = await s.create({ trigger: { type: 'event', event: 'start' }, steps: [{ type: 'command', command: 'say welcome back' }] });
  const flush = () => new Promise((r) => setImmediate(r));
  s.onPower('survival', { active: 'active' }, { active: 'inactive', result: 'success' });
  s.onPower('survival', { active: 'active' }, { active: 'failed', result: 'exit-code' }, { planned: true });
  await flush();
  assert.deepEqual(target.calls, []);
  s.onPower('survival', { active: 'active' }, { active: 'failed', result: 'exit-code' });
  await flush();
  assert.deepEqual(target.calls, ['power start']);
  s.onPower('survival', { active: 'active' }, { active: 'failed', result: 'oom-kill' }); // within the cooldown
  s.onPower('survival', { active: 'inactive' }, { active: 'active' });
  s.onPower('other', { active: 'inactive' }, { active: 'active' }); // another server's task list is empty
  await flush();
  assert.deepEqual(target.calls, ['power start', 'send say welcome back']);
  assert.ok(s.lastFired.has(onCrash.id) && s.lastFired.has(onStart.id));
});

test('events: empty for N minutes fires once per empty period; log lines match', async () => {
  const { s, target } = make();
  await s.load();
  await s.create({ trigger: { type: 'event', event: 'empty', minutes: 10, cooldownMinutes: 1 }, steps: [{ type: 'restart', warnSeconds: 0 }] });
  await s.create({ trigger: { type: 'event', event: 'log', match: "Can't keep up!", cooldownMinutes: 1 }, steps: [{ type: 'command', command: 'spark health' }] });
  const flush = () => new Promise((r) => setImmediate(r));
  const t0 = Date.now();
  s.onPlayers('survival', 0, t0);
  s.onPlayers('survival', 0, t0 + 9 * 60000);
  await flush();
  assert.deepEqual(target.calls, []);
  s.onPlayers('survival', 0, t0 + 10 * 60000);
  s.onPlayers('survival', 0, t0 + 11 * 60000);
  await flush();
  assert.deepEqual(target.calls, ['countdown 0 restarting']);
  s.onPlayers('survival', null, t0 + 12 * 60000); // stopped: not "empty"
  s.onLogLine('survival', "[10:00:00 WARN]: Can't keep up! Is the server overloaded? Running 5000ms");
  await flush();
  assert.deepEqual(target.calls, ['countdown 0 restarting', 'send spark health']);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Updates } = require('../lib/updates');

// Records every step so the order can be checked.
function setup({ power = 'active', cancel = false } = {}) {
  const calls = [];
  const deps = {
    jobs: { run: async (kind, args) => (calls.push(`job:${kind}${args.rollback ? ':rollback' : ''}`), { file: 'paper.jar' }) },
    backups: { run: async () => (calls.push('backup'), 'world.tar.gz') },
    countdown: {
      start: async (seconds, reason, { finish }) => {
        calls.push(`countdown:${seconds}`);
        if (cancel) throw new Error('Countdown cancelled');
        await finish();
      },
      restart: async () => calls.push('rcon-restart'),
    },
    rcon: { send: async (cmd) => calls.push(`rcon:${cmd.split(' ')[0]}`) },
    power: power && {
      state: async () => ({ available: true, active: power }),
      run: async (action) => calls.push(`power:${action}`),
      waitFor: async () => calls.push('wait-stopped'),
    },
    log: () => {},
    platform: () => ({ id: 'paper', name: 'Paper', updates: 'paper' }),
    mcDir: '/nonexistent',
    mcJar: 'paper.jar',
  };
  return { u: new Updates(deps), calls };
}

const finish = async (u) => {
  await u.running;
  return u.state;
};

test('update: players are disconnected and the server stopped before the backup; jar swapped while stopped', async () => {
  const { u, calls } = setup();
  u.start({ version: '26.3', build: 178, restartSeconds: 60, user: 't' });
  const st = await finish(u);
  assert.strictEqual(st.error, null);
  assert.deepStrictEqual(calls, ['countdown:60', 'rcon:kick', 'rcon:save-all', 'power:stop', 'wait-stopped', 'backup', 'job:paper-update', 'power:start']);
});

test('update: without service control the backup still follows the kick, then RCON restarts', async () => {
  const { u, calls } = setup({ power: null });
  u.start({ version: '26.3', build: 178, restartSeconds: 10, user: 't' });
  await finish(u);
  assert.deepStrictEqual(calls, ['countdown:10', 'rcon:kick', 'rcon:save-all', 'backup', 'job:paper-update', 'rcon-restart']);
});

test('update: a stopped server is backed up and updated without a countdown', async () => {
  const { u, calls } = setup({ power: 'inactive' });
  u.start({ version: '26.3', build: 178, user: 't' });
  await finish(u);
  assert.deepStrictEqual(calls, ['backup', 'job:paper-update']);
});

test('update: cancelling the countdown changes nothing', async () => {
  const { u, calls } = setup({ cancel: true });
  u.start({ version: '26.3', build: 178, user: 't' });
  const st = await finish(u);
  assert.match(st.error, /Nothing was changed/);
  assert.deepStrictEqual(calls, ['countdown:60']);
});

test('update: the server is started again even when the download fails', async () => {
  const { u, calls } = setup();
  u.jobs.run = async () => {
    calls.push('job:fail');
    throw new Error('checksum mismatch');
  };
  u.start({ version: '26.3', build: 178, user: 't' });
  const st = await finish(u);
  assert.strictEqual(st.error, 'checksum mismatch');
  assert.strictEqual(calls.at(-1), 'power:start');
});

test('update: the active server rconsole installed updates through server-update, any build type', async () => {
  const calls = [];
  const inst = { id: 'modded', distribution: 'neoforge', version: '26.3', build: '26.3.0.85', previous: null };
  const { u } = setup();
  u.instance = () => inst;
  u.jobs = { run: async (kind, args) => (calls.push([kind, args]), {}) };
  u.start({ version: '26.3', build: '26.3.0.86', user: 't' });
  const st = await finish(u);
  assert.strictEqual(st.error, null);
  assert.deepStrictEqual(calls.find(([k]) => k === 'server-update'), ['server-update', { id: 'modded', version: '26.3', build: '26.3.0.86' }]);
  assert.strictEqual((await u.installed()).source, 'instance');
  assert.throws(() => u.start({ version: '26.3', build: '1 -x', user: 't' }), /Invalid/);
});

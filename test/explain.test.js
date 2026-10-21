'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Explainer, redactor, knownNames, logContext, SECRET } = require('../lib/explain');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-explain-'));
const KEY = `sk-ant-api03-${'x'.repeat(40)}`;

test('takes out names, addresses, UUIDs, chat and secrets', () => {
  const mc = tmp();
  fs.writeFileSync(path.join(mc, 'usercache.json'), JSON.stringify([{ name: 'Lena_99', uuid: 'x' }, { name: 'Bo', uuid: 'y' }]));
  fs.writeFileSync(path.join(mc, 'ops.json'), JSON.stringify([{ name: 'mwinterstetter' }]));
  const names = knownNames(mc);
  assert.deepStrictEqual([...names].sort(), ['Lena_99', 'mwinterstetter'], 'two letters is no Minecraft name');
  const r = redactor(names);
  assert.strictEqual(r.line('[12:00:01 INFO]: <Lena_99> my address is 5 Elm St'), null, 'chat goes entirely');
  assert.strictEqual(r.line('[12:00:01] [Async Chat Thread - #3/INFO]: <Lena_99> hi'), null);
  assert.strictEqual(r.line('[12:00:01] [Server thread/INFO]: [Not Secure] <Lena_99> hi'), null, 'vanilla');
  assert.strictEqual(r.line('[12:00:01 INFO]: [Not Secure] <Lena_99> hi'), null);
  assert.notStrictEqual(r.line('[12:00:01 ERROR]: Could not pass event AsyncChatEvent to Foo v1'), null);
  r.learn(['[12:00:01 INFO]: Alex_7 issued server command: /home', '[12:00:02 INFO]: UUID of player Steve123 is 8f14e45f-ceea-467a-9b36-8b4b9f2a1c3d', '[12:00:02] [Server thread/INFO]: Alex_7 (/127.0.0.1:58748) lost connection: Timed out']);
  assert.strictEqual(r.line('[12:00:00 WARN]: Steve123 moved too quickly!'), '[12:00:00 WARN]: Player1 moved too quickly!', 'names are learned from all lines first');
  assert.strictEqual(r.line('[12:00:02 INFO]: UUID of player Steve123 is 8f14e45f-ceea-467a-9b36-8b4b9f2a1c3d'), '[12:00:02 INFO]: UUID of player Player1 is <uuid>');
  assert.strictEqual(r.line('Environment[sessionHost=https://sessionserver.mojang.com, name=PROD]'), 'Environment[sessionHost=https://sessionserver.mojang.com, name=PROD]');
  assert.strictEqual(r.line('[12:00:03 INFO]: Steve123[/203.0.113.9:51234] logged in with entity id 7'), '[12:00:03 INFO]: Player1[/•••] logged in with entity id 7');
  assert.strictEqual(r.text('Lena_99 and LENA_99 and mwinterstetter and Alex_7'), 'Player2 and Player2 and Player3 and Player4', 'the same player keeps their placeholder');
  assert.strictEqual(r.count, 4);
  assert.strictEqual(r.text('jdbc:mysql://luckperms:hunter2@10.0.0.5:3306/lp password=hunter2 token: abc123 Authorization: Bearer eyJhbGciOi'), 'jdbc:mysql://•••@•••:3306/lp password=••• token: ••• Authorization: •••');
  assert.strictEqual(r.text('webhook https://discord.com/api/webhooks/123/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abc mail me@example.org'), 'webhook https://discord.com/api/webhooks/123/••• mail •••@•••');
  // What a problem needs stays readable.
  const trace = '\tat net.minecraft.server.v1_21_R1.CraftServer.loadPlugins(CraftServer.java:512) ~[paper-1.21.4.jar:1.21.4-232-a1b2c3d]';
  assert.strictEqual(r.text(trace), trace);
  assert.strictEqual(r.text('Could not pass event PlayerJoinEvent to Essentials v2.21.0'), 'Could not pass event PlayerJoinEvent to Essentials v2.21.0');
});

test('finds the log lines around the last time the problem happened', async () => {
  const mc = tmp();
  const logs = path.join(mc, 'logs');
  fs.mkdirSync(logs);
  const lines = [];
  for (let i = 0; i < 60; i++) lines.push(`[10:00:${String(i).padStart(2, '0')} INFO]: line ${i}`);
  lines[20] = '[10:00:20 ERROR]: Could not pass event X to Foo v1';
  lines[40] = '[10:00:40 ERROR]: Could not pass event X to Foo v1';
  lines.splice(41, 0, 'java.lang.NullPointerException: boom', '\tat foo.Bar.baz(Bar.java:1)');
  fs.writeFileSync(path.join(logs, 'latest.log'), `${lines.join('\n')}\n`);
  const ctx = await logContext(logs, 'Could not pass event X to Foo v1', { before: 3, after: 4 });
  assert.deepStrictEqual(ctx, ['[10:00:37 INFO]: line 37', '[10:00:38 INFO]: line 38', '[10:00:39 INFO]: line 39', '[10:00:40 ERROR]: Could not pass event X to Foo v1', 'java.lang.NullPointerException: boom', '\tat foo.Bar.baz(Bar.java:1)', '[10:00:41 INFO]: line 41', '[10:00:42 INFO]: line 42']);
  assert.deepStrictEqual(await logContext(logs, 'never happened'), []);
});

const problem = { key: 'plugin|Foo|Could not pass event X to Foo v#', kind: 'plugin', severity: 'error', title: 'Plugin error', plugin: 'Foo', message: 'Could not pass event X to Foo v1 for Lena_99', detail: 'java.lang.NullPointerException: boom', count: 3, first: 1, last: 2 };
const answer = { summary: 'Foo crashes when a player joins.', severity: 'important', cause: 'A bug in Foo 1.', steps: ['Update Foo.', 'Restart the server.'] };

function reply(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function make({ fetch, env = {}, dir = tmp() } = {}) {
  const mc = tmp();
  fs.writeFileSync(path.join(mc, 'usercache.json'), JSON.stringify([{ name: 'Lena_99' }]));
  const calls = [];
  const e = new Explainer({
    stateDir: dir, mcDir: mc, env,
    problem: async (k) => (k === problem.key ? problem : null),
    context: async () => ({ server: { name: 'Paper', version: '26.3', build: 206 }, plugins: [{ name: 'Foo', version: '1' }], lines: ['[10:00:40 ERROR]: Could not pass event X to Foo v1 for Lena_99', '[10:00:41 INFO]: <Lena_99> lag!!'] }),
    fetch: async (url, opts) => {
      calls.push({ url, opts, body: JSON.parse(opts.body) });
      return fetch ? fetch(calls.at(-1)) : reply({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(answer) }], usage: { input_tokens: 900, output_tokens: 120 } });
    },
  });
  return { e, calls, dir };
}

test('off until an admin turns it on with a key, which never goes back to the browser', async () => {
  const { e, dir } = make();
  assert.deepStrictEqual([e.view().enabled, e.view().on, e.view().apiKey], [false, false, '']);
  await assert.rejects(e.explain(problem.key, 'm'), /off/);
  assert.throws(() => e.update({ enabled: true }), /API key/);
  assert.throws(() => e.update({ apiKey: 'hunter2' }), /doesn't look like/);
  assert.throws(() => e.update({ model: 'gpt-5' }), /Unknown model/);
  e.update({ enabled: true, apiKey: KEY });
  assert.deepStrictEqual([e.view().on, e.view().apiKey], [true, SECRET]);
  e.update({ apiKey: SECRET, model: 'claude-haiku-5-5' });
  assert.strictEqual(e.key, KEY, 'the placeholder keeps the key');
  assert.strictEqual(fs.statSync(path.join(dir, 'explain.json')).mode & 0o777, 0o600);
  const again = new Explainer({ stateDir: dir, mcDir: tmp(), problem: async () => null, context: async () => ({}) });
  assert.deepStrictEqual([again.on, again.config.model], [true, 'claude-haiku-5-5']);
  // A key in /etc/rconsole.env works too.
  const fromEnv = make({ env: { ANTHROPIC_API_KEY: KEY } }).e;
  fromEnv.update({ enabled: true });
  assert.deepStrictEqual([fromEnv.on, fromEnv.view().keyFromEnv, fromEnv.view().apiKey], [true, true, '']);
});

test('sends the redacted problem and reads the answer', async () => {
  const { e, calls } = make();
  e.update({ enabled: true, apiKey: KEY });
  const p = await e.preview(problem.key);
  assert.match(p.text, /Plugin error/);
  assert.match(p.text, /Paper 26\.3 build 206/);
  assert.doesNotMatch(p.text, /Lena_99|lag!!/);
  assert.strictEqual(p.players, 1);
  const a = await e.explain(problem.key, 'masseo');
  assert.deepStrictEqual([a.summary, a.severity, a.steps.length, a.by, a.tokens.input], [answer.summary, 'important', 2, 'masseo', 900]);
  const [c] = calls;
  assert.strictEqual(c.url, 'https://api.anthropic.com/v1/messages');
  assert.deepStrictEqual([c.opts.headers['x-api-key'], c.opts.headers['anthropic-version'], c.opts.headers['anthropic-beta']], [KEY, '2023-06-01', 'server-side-fallback-2026-07-01']);
  assert.deepStrictEqual([c.body.model, c.body.fallbacks, c.body.output_config.format.type, c.body.output_config.effort], ['claude-opus-5-5', 'default', 'json_schema', 'medium']);
  assert.strictEqual(c.body.messages[0].content, p.text, 'exactly what the preview showed');
  assert.strictEqual(e.cached(problem.key).summary, answer.summary);
  await assert.rejects(e.preview('nope'), /no longer/);

  // Haiku has no server-side fallback.
  e.update({ model: 'claude-haiku-5-5' });
  await e.explain(problem.key, 'masseo');
  assert.deepStrictEqual([calls[1].body.fallbacks, calls[1].opts.headers['anthropic-beta']], [undefined, undefined]);
});

test('says plainly what went wrong', async () => {
  const cases = [
    [() => reply({ error: { message: 'invalid x-api-key' } }, 401), /API key was refused/],
    [() => reply({ error: { message: 'Your credit balance is too low' } }, 400), /account behind this key/],
    [() => reply({ stop_reason: 'refusal', content: [] }), /declined/],
    [() => reply({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }), /could not be read/],
    [() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }, /Can't reach the Anthropic API: ENOTFOUND/],
  ];
  for (const [fetch, re] of cases) {
    const { e } = make({ fetch });
    e.update({ enabled: true, apiKey: KEY });
    await assert.rejects(e.explain(problem.key, 'm'), re);
  }
  const { e } = make();
  e.update({ enabled: true, apiKey: KEY });
  for (let i = 0; i < 20; i++) await e.explain(problem.key, 'm');
  await assert.rejects(e.explain(problem.key, 'm'), /20 explanations an hour/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Discord, relayLine, isWebhook } = require('../lib/discord');
const { Notify } = require('../lib/notify');

const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789ABCD';

function fakeFetch(statuses = []) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    const status = statuses.shift() || 204;
    return { ok: status < 300, status, json: async () => ({ retry_after: 0.01 }) };
  };
  return { fn, calls };
}

test('discord: relay lines are formatted and safe', () => {
  assert.strictEqual(relayLine('[10:00:00] [Async Chat Thread - #0/INFO]: <Alex> hi **all** @everyone'), '**Alex**: hi \\*\\*all\\*\\* @​everyone');
  assert.strictEqual(relayLine('[10:00:00] [Server thread/INFO]: System chat: Steve joined the game'), '➡️ **Steve** joined');
  assert.strictEqual(relayLine('[10:00:00] [Server thread/INFO]: Steve left the game'), '⬅️ **Steve** left');
  assert.strictEqual(relayLine('[10:00:00] [Server thread/INFO]: [Server] Restart at 4'), '📢 Restart at 4');
  assert.strictEqual(relayLine('[10:00:00] [Server thread/INFO]: Done (3.2s)!'), null);
  assert.ok(isWebhook(HOOK));
  assert.ok(!isWebhook('https://evil.example/api/webhooks/1/2'));
});

test('discord: alerts are embeds coloured by priority; chat is batched; 429 is respected', async () => {
  const f = fakeFetch([204, 429, 204]);
  const d = new Discord({ fetchImpl: f.fn });
  await d.alert(HOOK, { title: 'Server is down', message: 'x', priority: 5, link: 'https://rc.example/#server/overview' });
  assert.strictEqual(f.calls[0].body.embeds[0].color, 0xef4444);
  assert.deepStrictEqual(f.calls[0].body.allowed_mentions, { parse: [] });
  assert.strictEqual(f.calls[0].body.embeds[0].url, 'https://rc.example/#server/overview');

  d.relay(HOOK, '[10:00:00] [Async Chat Thread - #0/INFO]: <Alex> one');
  d.relay(HOOK, '[10:00:01] [Async Chat Thread - #0/INFO]: <Steve> two');
  assert.strictEqual(f.calls.length, 1); // waits for the batch
  await d.flush(HOOK); // → 429, kept for later
  assert.strictEqual(d.queue.length, 2);
  await new Promise((r) => setTimeout(r, 30));
  clearTimeout(d.timer);
  await d.flush(HOOK);
  assert.strictEqual(f.calls.at(-1).body.content, '**Alex**: one\n**Steve**: two\n');
});

test('notify: alerts go to Discord even without ntfy; webhook URLs never go back to the browser', async () => {
  const n = new Notify({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-notify-')) });
  const f = fakeFetch();
  n.discord = new Discord({ fetchImpl: f.fn });
  assert.throws(() => n.update({ discord: { url: 'https://example.com/hook' } }), /Discord webhook/);
  n.update({ discord: { url: HOOK, alerts: true, chatUrl: HOOK, chat: true } });
  assert.deepStrictEqual(n.view().discord, { hasUrl: true, alerts: true, hasChatUrl: true, chat: true });
  assert.ok(!JSON.stringify(n.view()).includes('abcdefghij'));
  n.update({ discord: { url: '••••' } }); // masked value: unchanged
  assert.strictEqual(n.config.discord.url, HOOK);
  assert.strictEqual(await n.send('down', { title: 'Minecraft server is down', message: 'gone' }), true);
  assert.strictEqual(f.calls[0].body.embeds[0].title, 'Minecraft server is down');
  n.onLogLine('[10:00:00] [Async Chat Thread - #0/INFO]: <Alex> hello');
  assert.deepStrictEqual(n.discord.queue, ['**Alex**: hello']);
  clearTimeout(n.discord.timer);
});

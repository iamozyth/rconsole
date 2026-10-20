'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JoinRequests, readWhitelistMessage } = require('../lib/joinrequests');
const { Scanners } = require('../lib/scanners');
const { invitePage } = require('../lib/invitepage');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-join-'));
const UUID = '0f3c1a2b-1111-4222-8333-944455556666';
// What Paper 26 writes when a player who isn't whitelisted tries to join.
// What Paper 26.3 wrote for one try (offline mode included).
const knockLines = (name, ip = '203.0.113.9') => [
  `[20:50:18] [User Authenticator #0/INFO]: UUID of player ${name} is ${UUID}`,
  `[20:50:18] [Server thread/INFO]: Disconnecting ${name} (/${ip}:58748): You are not whitelisted on this server!`,
  `[20:50:18] [Server thread/INFO]: ${name} (/${ip}:58748) lost connection: You are not whitelisted on this server!`,
];

function make(opts = {}) {
  const sent = [];
  const events = [];
  const j = new JoinRequests({
    stateDir: tmp(),
    server: 'survival',
    send: async (server, cmd) => (sent.push([server, cmd]), opts.reply ?? 'Added Lena to the whitelist'),
    lookup: opts.lookup || (async (name) => (name === 'Nobody' ? false : { id: UUID, name: name === 'lena' ? 'Lena' : name })),
    onRequest: (r) => events.push(['request', r.name]),
    onResolved: (r) => events.push([r.status, r.name]),
    ...opts.ctor,
  });
  j.ready = true;
  return { j, sent, events };
}

test('a whitelist kick becomes one request; later tries count up', () => {
  let t = Date.parse('2026-10-20T12:00:00Z');
  const { j, events } = make({ ctor: { now: () => t } });
  for (const l of knockLines('Lena')) j.onLogLine(l);
  t += 60000;
  for (const l of knockLines('Lena')) j.onLogLine(l);
  const v = j.view();
  assert.strictEqual(v.requests.length, 1);
  assert.deepStrictEqual([v.requests[0].name, v.requests[0].uuid, v.requests[0].ip, v.requests[0].count, v.requests[0].status], ['Lena', UUID, '203.0.113.9', 2, 'pending']);
  assert.deepStrictEqual(events, [['request', 'Lena']]);
  assert.strictEqual(j.pendingCount(), 1);
});

test('vanilla wording, offline mode without a UUID line, nothing for other reasons', () => {
  const { j } = make();
  j.onLogLine(`[20:41:03] [User Authenticator #1/INFO]: UUID of player Alex is ${UUID}`);
  j.onLogLine('[20:41:03] [Server thread/INFO]: Alex (/198.51.100.5:4000) lost connection: Disconnected');
  j.onLogLine('[20:41:03] [Server thread/INFO]: /198.51.100.6:4000 lost connection: You are not white-listed on this server!');
  assert.strictEqual(j.view().requests.length, 0);
  j.onLogLine('[20:41:04] [Server thread/INFO]: Steve (/198.51.100.4:4000) lost connection: You are not white-listed on this server!');
  assert.deepStrictEqual(j.view().requests.map((r) => [r.name, r.uuid]), [['Steve', null]]);
});

test('lines replayed at startup do not create requests', () => {
  const { j } = make();
  j.ready = false;
  for (const l of knockLines('Lena')) j.onLogLine(l);
  assert.strictEqual(j.view().requests.length, 0);
  assert.ok(j.isKnock('Lena', 'You are not whitelisted on this server!'), 'the UUID is still remembered for the scanner check');
});

test('allow whitelists on the server; ignore silences the name for a week', async () => {
  let t = Date.parse('2026-10-20T12:00:00Z');
  const { j, sent, events } = make({ ctor: { now: () => t } });
  for (const l of knockLines('Lena')) j.onLogLine(l);
  const id = j.view().requests[0].id;
  const r = await j.allow(id, 'masseo');
  assert.deepStrictEqual(sent, [['survival', 'whitelist add Lena']]);
  assert.strictEqual(r.status, 'allowed');
  assert.strictEqual(j.pendingCount(), 0);

  for (const l of knockLines('Griefer')) j.onLogLine(l);
  const g = j.view().requests.find((x) => x.name === 'Griefer');
  j.ignore(g.id, 'masseo');
  t += 60000;
  for (const l of knockLines('Griefer')) j.onLogLine(l);
  assert.strictEqual(j.view().requests.filter((x) => x.name === 'Griefer').length, 1);
  assert.strictEqual(j.view().requests.find((x) => x.name === 'Griefer').count, 2);
  assert.deepStrictEqual(events.map((e) => e[0]), ['request', 'allowed', 'request', 'ignored']);
  // Saved: a new instance reads the same requests.
  const again = new JoinRequests({ stateDir: path.dirname(j.file), server: 'survival', send: async () => '' });
  assert.strictEqual(again.view().requests.length, 2);
});

test('allow reports a server that refused, and keeps the request pending', async () => {
  const { j } = make({ reply: 'That player does not exist' });
  for (const l of knockLines('Lena')) j.onLogLine(l);
  await assert.rejects(j.allow(j.view().requests[0].id, 'm'), /didn't whitelist Lena/);
  assert.strictEqual(j.pendingCount(), 1);
});

test('requests of another server stay out of this one', async () => {
  const { j } = make();
  for (const l of knockLines('Lena')) j.onLogLine(l);
  const other = new JoinRequests({ stateDir: path.dirname(j.file), server: 'creative', send: async () => '' });
  assert.strictEqual(other.view().requests.length, 0);
  assert.strictEqual(other.pendingCount(), 0);
});

test('invites: hashed token, uses, expiry, Mojang name check, auto whitelist', async () => {
  let t = Date.parse('2026-10-20T12:00:00Z');
  const { j, sent } = make({ ctor: { now: () => t } });
  assert.throws(() => j.createInvite({ days: 200 }, 'm'), /1 to 90 days/);
  assert.throws(() => j.createInvite({ address: 'bad host!' }, 'm'), /host name/);
  const { token, invite } = j.createInvite({ label: 'Lena', days: 1, uses: 2, address: 'mc.example.com:25565' }, 'masseo');
  assert.strictEqual(invite.hash, undefined);
  assert.ok(!fs.readFileSync(j.file, 'utf8').includes(token), 'only the hash is stored');
  assert.ok(j.inviteFor(token));
  assert.strictEqual(j.inviteFor('x'.repeat(24)), null);

  await assert.rejects(j.redeem(token, 'Nobody', '1.1.1.1'), /no Minecraft account called Nobody/);
  await assert.rejects(j.redeem(token, 'bad name!', '1.1.1.1'), /up to 16/);
  const r1 = await j.redeem(token, 'lena', '1.1.1.1');
  assert.deepStrictEqual(r1, { name: 'Lena', status: 'pending' }, 'the exact spelling from Mojang');
  assert.strictEqual(sent.length, 0, 'asks the owner first');
  const again = await j.redeem(token, 'Lena', '1.1.1.1');
  assert.ok(again.again, 'the same name twice uses the invite once');
  await j.redeem(token, 'Alex', '1.1.1.1');
  assert.strictEqual(j.inviteFor(token), null, 'used up');
  await assert.rejects(j.redeem(token, 'Steve', '1.1.1.1'), /expired or was already used/);

  const auto = j.createInvite({ days: 1, uses: 5, auto: true }, 'masseo');
  const r2 = await j.redeem(auto.token, 'Steve', '2.2.2.2');
  assert.strictEqual(r2.status, 'allowed');
  assert.deepStrictEqual(sent, [['survival', 'whitelist add Steve']]);
  t += 2 * 24 * 3600 * 1000;
  assert.strictEqual(j.inviteFor(auto.token), null, 'expired');
  assert.strictEqual(j.view().invites.find((i) => i.id === auto.invite.id).active, false);

  const rev = j.createInvite({ days: 0 }, 'm');
  j.revokeInvite(rev.invite.id);
  assert.strictEqual(j.inviteFor(rev.token), null);
});

test('invites: offline lookups and rate limit', async () => {
  const { j } = make({ lookup: async () => null });
  const { token } = j.createInvite({ uses: 50 }, 'm');
  assert.deepStrictEqual(await j.redeem(token, 'Anyone', '9.9.9.9'), { name: 'Anyone', status: 'pending' }, 'Mojang unreachable: the server checks the name later');
  for (let i = 0; i < 9; i++) await j.redeem(token, `P${i}`, '9.9.9.9');
  await assert.rejects(j.redeem(token, 'More', '9.9.9.9'), /Too many tries/);
});

test('spigot.yml whitelist message counts as a whitelist kick', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'spigot.yml'), "settings:\n  debug: false\nmessages:\n  whitelist: '&cMembers only, ask on Discord'\n  unknown-command: Unknown\n");
  assert.strictEqual(readWhitelistMessage(dir), 'Members only, ask on Discord');
  const { j } = make({ ctor: { mcDir: dir } });
  j.onLogLine(`[20:41:04] [User Authenticator #1/INFO]: UUID of player Lena is ${UUID}`);
  j.onLogLine('[20:41:04] [Server thread/INFO]: Disconnecting Lena (/203.0.113.9:4000): Members only, ask on Discord');
  assert.strictEqual(j.pendingCount(), 1);
});

test('scanners leave whitelist knocks to join requests', () => {
  const { j } = make();
  const seen = [];
  const s = new Scanners({ onAttempt: (a) => seen.push(a), skip: (name, reason) => j.isKnock(name, reason) });
  s.seed({ players: [], attempts: [] });
  for (const l of knockLines('Lena')) {
    j.onLogLine(l);
    s.onLogLine(l);
  }
  s.onLogLine('[20:41:09] [Server thread/INFO]: /198.51.100.77:5000 lost connection: Disconnected');
  assert.deepStrictEqual(seen.map((a) => a.ip), ['198.51.100.77']);
});

test('invite page escapes everything it shows', () => {
  const html = invitePage({ state: 'form', invite: { label: 'for Lena', address: 'mc.example.com', auto: false }, server: '<script>x</script>', name: '"><img>', error: 'a<b' });
  assert.ok(!html.includes('for Lena'), 'the label is the owner\'s note');
  assert.ok(!html.includes('<script>x'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('"><img>'));
  assert.ok(html.includes('mc.example.com'));
  assert.ok(!/<script/i.test(html), 'no script at all');
  assert.ok(invitePage({ state: 'gone' }).includes("can't be used"));
});

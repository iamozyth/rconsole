'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Rehearsal, analyze, compare } = require('../lib/rehearsal');
const { plan, boot } = require('../bin/mc-rehearsal');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-rehearsal-'));

// Startup lines as Paper 26.3 prints them on its console, and as vanilla and
// Forge (and latest.log) write them.
const current = {
  up: true,
  seconds: 17.3,
  notable: [
    '[00:46:48 INFO]: Starting minecraft server version 26.3',
    '[00:46:49 WARN]: Failed to load the mojang session service (connect timed out)',
    "[00:46:50 WARN]: Can't keep up! Is the server overloaded? Running 2513ms or 50 ticks behind",
    '[00:46:52 INFO]: [QaPlugin] Enabling QaPlugin v1.4.2',
    "[00:46:52 WARN]: [QaPlugin] config.yml uses the old 'spawn-radius' key; it still works",
    '[00:46:58 INFO]: Done (11.902s)! For help, type "help"',
    '[00:47:05 INFO]: Stopping server',
    '[00:47:05 INFO]: [QaPlugin] Disabling QaPlugin v1.4.2',
    '[00:47:06 WARN]: Shutdown warning that does not count',
  ],
};
const broken = {
  up: true,
  seconds: 15.2,
  notable: [
    '[00:47:21 INFO]: Starting minecraft server version 26.3',
    '[00:47:22 WARN]: Failed to load the mojang session service (connect timed out)',
    '[00:47:25 INFO]: [QaPlugin] Enabling QaPlugin v1.4.2',
    "[00:47:25 WARN]: [QaPlugin] config.yml uses the old 'spawn-radius' key; it still works",
    '[00:47:25 ERROR]: Error occurred while enabling QaPlugin v1.4.2 (Is it up to date?)',
    'java.lang.IllegalStateException: QaPlugin needs Player#getSpawnRadius',
    '\tat QaPlugin.jar//qa.QaPlugin.onEnable(QaPlugin.java:5) ~[?:?]',
    '\tat org.bukkit.plugin.java.JavaPlugin.setEnabled(JavaPlugin.java:280) ~[paper-api.jar:?]',
    '[00:47:25 INFO]: [QaPlugin] Disabling QaPlugin v1.4.2',
    '[00:47:31 INFO]: Done (10.4s)! For help, type "help"',
  ],
};

test('reads what started, what failed and what was logged before the stop', () => {
  const a = analyze(current);
  assert.deepStrictEqual(a.plugins, { QaPlugin: '1.4.2' });
  assert.deepStrictEqual(a.problems.map((p) => p.level), ['warning', 'warning', 'warning'], 'the shutdown warning is left out');
  const b = analyze(broken);
  assert.deepStrictEqual(b.plugins, {});
  assert.deepStrictEqual(b.failed, ['QaPlugin']);
  const err = b.problems.find((p) => p.level === 'error');
  assert.match(err.text, /Error occurred while enabling QaPlugin/);
  assert.strictEqual(err.detail.length, 3, 'the exception and its stack');
  // Vanilla and Forge put the thread in brackets.
  const forge = analyze({ up: true, notable: ['[10:00:01] [main/WARN] [ne.ne.fm.ModLoader/]: Mod create needs a newer NeoForge', '[10:00:02] [Server thread/ERROR]: Couldn\'t load chunk [3, 4]', '[10:00:09] [Server thread/INFO]: Done (8.1s)!'] });
  assert.deepStrictEqual(forge.problems.map((p) => [p.level, p.text]), [['warning', 'Mod create needs a newer NeoForge'], ['error', "Couldn't load chunk [3, 4]"]]);
});

test('compares the update with the current version', () => {
  const same = compare(current, { ...current, seconds: 15, notable: current.notable.map((l) => l.replace('2513ms or 50', '4100ms or 82')) });
  assert.strictEqual(same.verdict, 'works', 'numbers in a message make no difference');
  const r = compare(current, broken);
  assert.strictEqual(r.verdict, 'problems');
  assert.deepStrictEqual(r.lostPlugins, ['QaPlugin']);
  assert.deepStrictEqual(r.added.map((p) => p.level), ['error']);
  assert.deepStrictEqual([r.current.plugins, r.next.plugins], [1, 0]);

  const warn = compare(current, { ...current, notable: ['[00:00:01 WARN]: Legacy chunk format found, converting', ...current.notable] });
  assert.strictEqual(warn.verdict, 'warnings');
  const down = compare(current, { up: false, timedOut: true, notable: [], tail: ['[00:00:01 INFO]: Loading libraries', '[00:00:59 ERROR]: Encountered an unexpected exception'], crash: '---- Minecraft Crash Report ----' });
  assert.strictEqual(down.verdict, 'fails');
  assert.match(down.next.why, /within 6 minutes/);
  assert.strictEqual(down.tail.length, 2);
  assert.ok(down.crash);
  assert.strictEqual(compare({ up: false, exit: 1, tail: ['x'] }, broken).verdict, 'inconclusive');
});

function fakeJobs(results = {}) {
  const calls = [];
  return {
    calls,
    async run(kind, args) {
      calls.push([kind, args]);
      const r = results[kind];
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? r(args) : r;
    },
  };
}
const inst = { id: 'survival', distribution: 'paper', kind: 'server', version: '26.3', build: 206, memoryMb: 4096 };

test('a rehearsal prepares, starts both versions, compares and always cleans up', async () => {
  const jobs = fakeJobs({
    'rehearsal-prepare': { token: 'a'.repeat(16), next: { version: '26.3', build: 208 }, copied: { bytes: 1e8, worldRegionsLeftOut: 5 } },
    'rehearsal-boot': ({ which }) => (which === 'current' ? current : broken),
    'rehearsal-clean': {},
  });
  const dir = tmp();
  const r = new Rehearsal({ jobs, instance: () => inst, stateDir: dir, memAvailable: () => 3000 });
  const st = r.start({ version: '26.3', build: 208 }, 'masseo');
  assert.strictEqual(st.running, true);
  assert.throws(() => r.start({ version: '26.3', build: 208 }, 'masseo'), /already running/);
  await r.running;
  assert.deepStrictEqual(jobs.calls.map(([k, a]) => [k, a.which || null]), [['rehearsal-prepare', null], ['rehearsal-boot', 'current'], ['rehearsal-boot', 'next'], ['rehearsal-clean', null]]);
  assert.strictEqual(jobs.calls[0][1].memoryMb, 2232, 'what is free, less some room for the machine');
  assert.strictEqual(r.view().results[0].verdict, 'problems');
  assert.strictEqual(new Rehearsal({ jobs, instance: () => inst, stateDir: dir }).result(r.results[0].id).lostPlugins[0], 'QaPlugin');

  // A failed start of the copy is a result too, and the copy still goes.
  const failing = fakeJobs({ 'rehearsal-prepare': { token: 'b'.repeat(16), next: { version: '26.3', build: 208 } }, 'rehearsal-boot': new Error('rconsole-try@ is not installed (see README).'), 'rehearsal-clean': {} });
  const r2 = new Rehearsal({ jobs: failing, instance: () => inst, stateDir: tmp(), memAvailable: () => 8000 });
  r2.start({ version: '26.3', build: 208 }, 'masseo');
  await r2.running;
  assert.deepStrictEqual([r2.results[0].verdict, failing.calls.at(-1)[0]], ['error', 'rehearsal-clean']);
  assert.strictEqual(failing.calls[0][1].memoryMb, 4096, 'never more than the server has');
});

test('says why a server can\'t be rehearsed', () => {
  const make = (i, mem = 8000) => new Rehearsal({ jobs: fakeJobs(), instance: () => i, stateDir: tmp(), memAvailable: () => mem });
  assert.match(make(null).view().reason, /servers rconsole installed/);
  assert.match(make({ ...inst, kind: 'proxy', distribution: 'velocity' }).view().reason, /Proxies/);
  assert.match(make({ ...inst, distribution: 'fabric' }).view().reason, /fabric/);
  assert.throws(() => make(inst, 1200).start({ version: '26.3', build: 208 }, 'm'), /Not enough free memory/);
  assert.throws(() => make(inst).start({ version: 'latest' }, 'm'), /Invalid version/);
});

test('the copy leaves out the world away from spawn, map tiles, logs and links', () => {
  const src = tmp();
  const put = (rel, size = 10) => {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), Buffer.alloc(size));
  };
  for (const f of ['server.properties', 'paper.jar', 'world/level.dat', 'world/dimensions/minecraft/overworld/region/r.0.0.mca', 'world/dimensions/minecraft/overworld/region/r.-1.-1.mca', 'world/dimensions/minecraft/overworld/region/r.5.2.mca', 'world/dimensions/minecraft/overworld/entities/r.9.9.mca', 'world_nether/DIM-1/region/r.0.-1.mca', 'plugins/LuckPerms/config.yml', 'plugins/BlueMap/web/maps/world/tile.png', 'logs/latest.log', '.rconsole-snapshot/x.jar', 'cache/mojang_26.3.jar']) put(f);
  fs.symlinkSync('/etc/passwd', path.join(src, 'plugins', 'link.yml'));
  const p = plan(src);
  assert.deepStrictEqual(p.files.map(([f]) => f).sort(), ['cache/mojang_26.3.jar', 'paper.jar', 'plugins/LuckPerms/config.yml', 'server.properties', 'world/dimensions/minecraft/overworld/region/r.-1.-1.mca', 'world/dimensions/minecraft/overworld/region/r.0.0.mca', 'world/level.dat', 'world_nether/DIM-1/region/r.0.-1.mca']);
  assert.deepStrictEqual([p.skipped.worldRegions, p.skipped.links, p.skipped.large], [2, 1, ['plugins/BlueMap/web']]);
});

test('a start is up at "Done", is stopped through the console, and a crash is not', async () => {
  const dir = tmp();
  const fake = path.join(dir, 'fake.js');
  fs.writeFileSync(fake, `
    const mode = process.argv[2];
    console.log('[00:00:01 INFO]: Starting minecraft server version 26.3');
    if (mode === 'crash') { console.log('[00:00:02 ERROR]: Encountered an unexpected exception'); process.exit(1); }
    if (mode === 'hang') { setInterval(() => {}, 1000); return; }
    console.log('[00:00:03 INFO]: Done (1.0s)! For help, type "help"');
    process.stdin.on('data', (d) => { if (String(d).trim() === 'stop') { console.log('[00:00:04 INFO]: Stopping server'); process.exit(0); } });
  `);
  const fast = { settleMs: 50, stopMs: 2000, bootMs: 3000 };
  const ok = await boot(dir, [process.execPath, fake, 'ok'], fast);
  assert.deepStrictEqual([ok.up, ok.exit, ok.stoppedByUs, ok.timedOut], [true, 0, true, false]);
  assert.ok(ok.notable.some((l) => l.includes('Stopping server')));
  const crash = await boot(dir, [process.execPath, fake, 'crash'], fast);
  assert.deepStrictEqual([crash.up, crash.exit], [false, 1]);
  assert.match(crash.tail.at(-1), /unexpected exception/);
  const hang = await boot(dir, [process.execPath, fake, 'hang'], { ...fast, bootMs: 300, stopMs: 300 });
  assert.deepStrictEqual([hang.up, hang.timedOut, hang.signal], [false, true, 'SIGKILL']);
});

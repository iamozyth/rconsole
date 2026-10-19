'use strict';
// The launcher that turns instance.json into the java command for systemd.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchEnv } = require('../bin/mc-launch');

function setup(patch = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rconsole-launch-'));
  fs.mkdirSync(path.join(dir, '.java', '25', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.java', '25', 'bin', 'java'), '');
  fs.mkdirSync(path.join(dir, 'survival'));
  fs.writeFileSync(path.join(dir, 'survival', 'paper.jar'), '');
  const instance = { id: 'survival', distribution: 'paper', version: '26.3', build: 178, java: 25, memoryMb: 2048, port: 25565, flags: 'default', launch: { type: 'jar', path: 'paper.jar' }, ...patch };
  fs.writeFileSync(path.join(dir, 'survival', 'instance.json'), JSON.stringify(instance));
  return dir;
}

test('writes JAVA and JAVA_ARGS from the instance', () => {
  const dir = setup();
  assert.strictEqual(launchEnv(dir, 'survival'), `JAVA=${dir}/.java/25/bin/java\nJAVA_ARGS=-Xms1024M -Xmx2048M -XX:+UseG1GC -Xlog:gc:file=logs/gc.log:time:filecount=2,filesize=4M -jar paper.jar nogui\n`);
});

test('refuses a missing Java, a missing jar and a linked Java folder', () => {
  assert.throws(() => launchEnv(setup({ java: 21 }), 'survival'), /missing/);
  assert.throws(() => launchEnv(setup({ launch: { type: 'jar', path: 'other.jar' } }), 'survival'), /missing/);
  const dir = setup();
  fs.rmSync(path.join(dir, '.java', '25'), { recursive: true });
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-jre-'));
  fs.mkdirSync(path.join(elsewhere, 'bin'));
  fs.writeFileSync(path.join(elsewhere, 'bin', 'java'), '');
  fs.symlinkSync(elsewhere, path.join(dir, '.java', '25'));
  assert.throws(() => launchEnv(dir, 'survival'), /link/);
});

test('refuses relative or odd servers folders and instances not yet installed', () => {
  assert.throws(() => launchEnv('srv/x', 'survival'), /servers folder/);
  assert.throws(() => launchEnv('/srv/../etc', 'survival'), /servers folder/);
  assert.throws(() => launchEnv(setup({ launch: null }), 'survival'), /not installed/);
});

#!/usr/bin/env node
'use strict';

// ExecStartPre of rconsole-mc@<id>.service, as the Minecraft user:
//
//   mc-launch.js <servers-dir> <id>
//
// Reads <servers-dir>/<id>/instance.json (validated, no links), finds the
// Java runtime in <servers-dir>/.java/<major>, and writes
// $RUNTIME_DIRECTORY/launch.env with JAVA and JAVA_ARGS for ExecStart. Every
// argument comes from lib/instances.js and is a plain token, so systemd's
// word splitting of $JAVA_ARGS can't change its meaning.

const fs = require('fs');
const path = require('path');
const instances = require('../lib/instances');

const DIR_RE = /^\/[A-Za-z0-9._/-]+$/;
const TOKEN_RE = /^[A-Za-z0-9@_.:+=/,-]+$/;

const fail = (msg) => {
  throw new Error(msg);
};

// Each path component below `root` must exist and not be a link.
function plainPath(root, ...parts) {
  let p = root;
  for (const part of parts) {
    p = path.join(p, part);
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st) fail(`${p} is missing`);
    if (st.isSymbolicLink()) fail(`${p} is a link`);
  }
  return p;
}

function launchEnv(serversDir, id) {
  if (!DIR_RE.test(serversDir) || serversDir.split('/').includes('..')) fail('Invalid servers folder');
  const instance = instances.read(serversDir, id);
  const javaHome = path.join(serversDir, '.java', String(instance.java));
  const java = plainPath(serversDir, '.java', String(instance.java), 'bin', 'java');
  if (!fs.statSync(java).isFile()) fail(`Java ${instance.java} is not installed (${java})`);
  if (!instance.launch) fail(`${id} is not installed yet`);
  plainPath(path.join(serversDir, id), ...instance.launch.path.split('/'));
  // The GC log goes to logs/, which the server only creates on its first start.
  const logs = path.join(serversDir, id, 'logs');
  if (!fs.existsSync(logs)) fs.mkdirSync(logs, { mode: 0o750 });
  else if (fs.lstatSync(logs).isSymbolicLink()) fail(`${logs} is a link`);
  const [bin, ...args] = instances.command(instance, javaHome);
  for (const a of [bin, ...args]) if (!TOKEN_RE.test(a)) fail(`Unsafe argument ${a}`);
  return `JAVA=${bin}\nJAVA_ARGS=${args.join(' ')}\n`;
}

module.exports = { launchEnv };

if (require.main === module) {
  try {
    const [serversDir, id] = process.argv.slice(2);
    const runtime = process.env.RUNTIME_DIRECTORY?.split(':')[0];
    if (!runtime) fail('RUNTIME_DIRECTORY is not set (run from rconsole-mc@.service)');
    const env = launchEnv(serversDir || '', id || '');
    fs.writeFileSync(path.join(runtime, 'launch.env.tmp'), env, { mode: 0o640 });
    fs.renameSync(path.join(runtime, 'launch.env.tmp'), path.join(runtime, 'launch.env'));
    process.stdout.write(env.split('\n')[1] ? `starting ${id}: ${env.split('\n')[1].slice('JAVA_ARGS='.length)}\n` : '');
  } catch (err) {
    console.error(`mc-launch: ${err.message}`);
    process.exit(1);
  }
}

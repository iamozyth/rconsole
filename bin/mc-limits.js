#!/usr/bin/env node
'use strict';

// rconsole-limits.service, as root: what rconsole itself may not change.
//
//   - a systemd drop-in per server (rconsole-mc@<id>.service.d) with its
//     MemoryMax (heap plus room for the JVM) and, when the port lock is on,
//     SocketBindAllow for its game, RCON and extra ports only;
//   - an nftables table that drops RCON connections from other machines
//     (RCON is plain text; rconsole talks to it over 127.0.0.1). Turned off
//     with RCON_FIREWALL=off.
//
// rconsole starts it after creating, changing or deleting a server and when
// it starts. Everything comes from instance.json (validated, no links); the
// RCON port of a pre-4.3 server comes from its server.properties, and only
// when it lies in the range rconsole hands out.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../lib/config');
const instances = require('../lib/instances');
const properties = require('../lib/properties');

const UNIT_DIR = process.env.SYSTEMD_UNIT_DIR || '/etc/systemd/system';
const DROPIN = '50-rconsole-limits.conf';
const DIR_RE = /^rconsole-mc@([a-z0-9][a-z0-9-]{0,31})\.service\.d$/;
const OLD_RCON_RANGE = [25575, 25675];
const TABLE = 'rconsole';

const port = (v) => (Number.isInteger(Number(v)) && Number(v) >= 1024 && Number(v) <= 65535 ? Number(v) : null);

// server.properties of a folder, read without following links; {} if unreadable.
function readProps(dir) {
  let fd;
  try {
    fd = fs.openSync(path.join(dir, 'server.properties'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 256 * 1024) return {};
    return properties.toObject(properties.parse(fs.readFileSync(fd, 'utf8')));
  } catch {
    return {};
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function rconPortOf(dir, i) {
  if (i.rconPort) return i.rconPort;
  const p = port(readProps(path.join(dir, i.id))['rcon.port']);
  return p && p >= OLD_RCON_RANGE[0] && p <= OLD_RCON_RANGE[1] ? p : null;
}

function dropin(i, rconPort) {
  const lines = ['# Written by rconsole-limits.service from instance.json; changes are overwritten.', '[Service]', `MemoryMax=${instances.memoryMaxMb(i)}M`];
  if (i.portLock) {
    // The game and RCON speak TCP; extra ports (maps, voice chat) either.
    // Port 0 (a free port, e.g. for outgoing connections) stays allowed.
    const tcp = [i.port, rconPort].filter(Boolean);
    for (const p of tcp) lines.push(`SocketBindAllow=tcp:${p}`);
    for (const p of i.extraPorts.filter((x) => !tcp.includes(x))) lines.push(`SocketBindAllow=${p}`);
    lines.push('SocketBindDeny=any');
  }
  return `${lines.join('\n')}\n`;
}

// Writes or removes drop-ins; true when anything changed.
function writeDropins(servers, unitDir = UNIT_DIR) {
  let changed = false;
  const want = new Map(servers.map(({ i, rconPort }) => [i.id, dropin(i, rconPort)]));
  for (const [id, text] of want) {
    const dir = path.join(unitDir, `rconsole-mc@${id}.service.d`);
    const file = path.join(dir, DROPIN);
    let old = null;
    try {
      old = fs.readFileSync(file, 'utf8');
    } catch {}
    if (old === text) continue;
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(`${file}.tmp`, text, { mode: 0o644 });
    fs.renameSync(`${file}.tmp`, file);
    changed = true;
  }
  for (const name of fs.readdirSync(unitDir)) {
    const m = DIR_RE.exec(name);
    if (!m || want.has(m[1])) continue;
    const file = path.join(unitDir, name, DROPIN);
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file);
    changed = true;
    try {
      fs.rmdirSync(path.join(unitDir, name));
    } catch {}
  }
  return changed;
}

const loopback = (host) => /^(127\.|::1$|localhost$)/.test(String(host || ''));

// RCON ports to close to other machines: every server's, and the attached
// server's when rconsole reaches it locally. Never a port anything plays on
// or rconsole's own web port.
function rconPorts(servers, env = process.env) {
  const close = new Set(servers.map((s) => s.rconPort).filter(Boolean));
  const open = new Set(servers.map((s) => s.i.port));
  if (fs.existsSync(path.join(config.mcDir, 'server.properties'))) {
    const legacy = readProps(config.mcDir);
    open.add(port(legacy['server-port']) || 25565);
    if (loopback(config.rconHost)) close.add(port(legacy['rcon.port']) || config.rconPort);
  }
  open.add(config.webPort);
  return [...close].filter((p) => p && !open.has(p)).sort((a, b) => a - b);
}

// An atomic nft script: the table is created if missing, then replaced.
function nftScript(ports) {
  const head = `table inet ${TABLE}\ndelete table inet ${TABLE}\n`;
  if (!ports.length) return head;
  return `${head}table inet ${TABLE} {
  chain input {
    type filter hook input priority -5; policy accept;
    iif "lo" accept
    tcp dport { ${ports.join(', ')} } drop
  }
}
`;
}

// What rconsole shows under Problems: which RCON ports are closed.
const STATUS_DIR = process.env.RUNTIME_DIRECTORY?.split(':')[0];
function writeStatus(firewall, closed) {
  if (!STATUS_DIR) return;
  const file = path.join(STATUS_DIR, 'status.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ at: new Date().toISOString(), firewall, closed }), { mode: 0o644 });
  fs.renameSync(`${file}.tmp`, file);
}

function main() {
  const dir = config.serversDir;
  const list = instances.list(dir, (name, err) => name && console.error(`skipping ${name}: ${err.message}`));
  const servers = list.map((i) => ({ i, rconPort: rconPortOf(dir, i) }));
  if (writeDropins(servers)) {
    const r = spawnSync('systemctl', ['daemon-reload'], { stdio: 'inherit' });
    if (r.status !== 0) console.error('systemctl daemon-reload failed');
  }
  console.log(`limits: ${servers.map(({ i }) => `${i.id} ${instances.memoryMaxMb(i)} MB${i.portLock ? ', ports locked' : ''}`).join('; ') || 'no servers'}`);

  if (/^(off|false|0|no)$/i.test(process.env.RCON_FIREWALL || '')) {
    spawnSync('nft', ['-f', '-'], { input: nftScript([]), stdio: ['pipe', 'ignore', 'ignore'] });
    writeStatus('off', []);
    console.log('firewall: off (RCON_FIREWALL)');
    return;
  }
  const ports = rconPorts(servers);
  const r = spawnSync('nft', ['-f', '-'], { input: nftScript(ports), stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.error?.code === 'ENOENT') {
    writeStatus('missing', []);
    console.error('firewall: nft is not installed (apt install nftables); RCON stays reachable from other machines');
  } else if (r.status !== 0) {
    writeStatus('error', []);
    process.exitCode = 1;
  } else {
    writeStatus('on', ports);
    console.log(`firewall: RCON ports ${ports.join(', ') || 'none'} closed to other machines`);
  }
}

module.exports = { dropin, writeDropins, rconPorts, nftScript };

if (require.main === module) main();

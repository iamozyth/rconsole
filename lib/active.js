'use strict';

// The server rconsole shows and operates. With servers in SERVERS_DIR, it is
// the one named in STATE_DIR/active-server (or the first one), and every
// existing view (console, worlds, backups, players, plugins, updates) works on
// it as on MC_DIR before: its folder, its rconsole-mc@ unit, its RCON. With
// none, rconsole runs on MC_DIR and MC_SERVICE from /etc/rconsole.env as before.

const fs = require('fs');
const path = require('path');
const instances = require('./instances');
const properties = require('./properties');

const FILE = 'active-server';

function pick({ serversDir, stateDir, log = () => {} }) {
  const all = instances.list(serversDir, (name, err) => name && log(`servers: skipping ${name}: ${err.message}`));
  let wanted = '';
  try {
    wanted = fs.readFileSync(path.join(stateDir, FILE), 'utf8').trim();
  } catch {}
  return all.find((i) => i.id === wanted) || all.find((i) => i.kind === 'server') || null;
}

function setActive(stateDir, id) {
  if (!instances.ID_RE.test(String(id))) throw new Error('Invalid server id');
  fs.writeFileSync(path.join(stateDir, `${FILE}.tmp`), `${id}\n`, { mode: 0o600 });
  fs.renameSync(path.join(stateDir, `${FILE}.tmp`), path.join(stateDir, FILE));
}

// The config values that change when `instance` is the active server.
function overrides(serversDir, instance) {
  const dir = path.join(serversDir, instance.id);
  let props = {};
  try {
    props = properties.toObject(properties.parse(fs.readFileSync(path.join(dir, 'server.properties'), 'utf8')));
  } catch {}
  return {
    activeServer: instance.id,
    mcDir: dir,
    mcService: `rconsole-mc@${instance.id}.service`,
    mcJar: instance.launch?.type === 'jar' ? instance.launch.path : 'server.jar',
    rconHost: '127.0.0.1',
    rconPort: Number(props['rcon.port']) || 25575,
    rconPassword: props['enable-rcon'] === 'true' ? props['rcon.password'] || '' : '',
  };
}

module.exports = { pick, setActive, overrides };

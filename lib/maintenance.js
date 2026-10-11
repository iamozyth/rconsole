'use strict';

// Maintenance mode: only operators can stay or join. Whitelisted non-ops are
// taken off the whitelist (remembered on disk first, so a crash can't lose
// them), the whitelist is switched on, and non-op players are kicked.
// Turning it off restores exactly what was there.

const fs = require('fs');
const path = require('path');
const { readAccess } = require('./access');

class Maintenance {
  constructor({ mcDir, stateDir, rcon, log }) {
    Object.assign(this, { mcDir, rcon, log });
    this.file = path.join(stateDir, 'maintenance.json');
  }

  state() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return { enabled: false };
    }
  }

  save(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(state, null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  async enable({ user, message = 'The server is in maintenance. Back soon!' }) {
    if (this.state().enabled) throw Object.assign(new Error('Maintenance mode is already on'), { status: 409 });
    message = String(message).replace(/[\r\n]/g, ' ').slice(0, 200);
    await this.rcon.send('list'); // fails early when the server is down
    const access = await readAccess(this.mcDir);
    const ops = new Set(access.ops.map((o) => o.name.toLowerCase()));
    const removed = access.whitelist.map((p) => p.name).filter((n) => !ops.has(n.toLowerCase()));
    const state = { enabled: true, since: new Date().toISOString(), user, message, whitelistWasOn: access.whitelistEnabled, removed };
    this.save(state);

    for (const name of removed) await this.rcon.send(`whitelist remove ${name}`);
    await this.rcon.send('whitelist on');
    const online = (await this.rcon.send('list')).split(':').slice(1).join(':').split(',').map((s) => s.trim()).filter(Boolean);
    const kicked = online.filter((n) => !ops.has(n.toLowerCase()));
    for (const name of kicked) await this.rcon.send(`kick ${name} ${message}`);
    this.log(`maintenance: on by ${user}, ${removed.length} taken off the whitelist, ${kicked.length} kicked`);
    return { ...state, kicked };
  }

  async disable({ user }) {
    const state = this.state();
    if (!state.enabled) throw Object.assign(new Error('Maintenance mode is off'), { status: 409 });
    for (const name of state.removed) await this.rcon.send(`whitelist add ${name}`);
    if (!state.whitelistWasOn) await this.rcon.send('whitelist off');
    this.save({ enabled: false, last: { ...state, endedBy: user, ended: new Date().toISOString() } });
    this.log(`maintenance: off by ${user}, ${state.removed.length} restored to the whitelist`);
    return { enabled: false, restored: state.removed };
  }
}

module.exports = { Maintenance };

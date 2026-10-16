'use strict';

// The servers rconsole installed (SERVERS_DIR, lib/instances.js): list them
// with their state, create and delete them through helper jobs, start and
// stop their rconsole-mc@<id> units, and type into their console FIFO.
// rconsole itself never writes into SERVERS_DIR.

const fs = require('fs');
const path = require('path');
const instances = require('./instances');
const distributions = require('./distributions');
const properties = require('./properties');
const { Power } = require('./power');

const COMMAND_MAX = 1000;

const httpError = (status, message) => Object.assign(new Error(message), { status });

class Servers {
  constructor({ serversDir, jobs, ops, log, fifoDir = '/run', makePower = (unit) => new Power({ unit, log }) }) {
    Object.assign(this, { serversDir, jobs, ops, log, fifoDir, makePower });
    this.powers = new Map();
  }

  unit(id) {
    return `rconsole-mc@${id}.service`;
  }

  power(id) {
    if (!instances.ID_RE.test(String(id))) throw httpError(400, 'Invalid server id');
    if (!this.powers.has(id)) this.powers.set(id, this.makePower(this.unit(id)));
    return this.powers.get(id);
  }

  get(id) {
    try {
      return instances.read(this.serversDir, id);
    } catch (err) {
      throw httpError(err.code === 'ENOENT' ? 404 : 400, err.code === 'ENOENT' ? `No server named ${id}` : err.message);
    }
  }

  // RCON port and password of an instance, for talking to it.
  rconOf(id) {
    try {
      const p = properties.toObject(properties.parse(fs.readFileSync(path.join(this.serversDir, id, 'server.properties'), 'utf8')));
      return p['enable-rcon'] === 'true' && p['rcon.password'] ? { port: Number(p['rcon.port']) || 25575, password: p['rcon.password'] } : null;
    } catch {
      return null;
    }
  }

  async list() {
    const all = instances.list(this.serversDir, (name, err) => name && this.log(`servers: skipping ${name}: ${err.message}`));
    return Promise.all(
      all.map(async (i) => {
        const st = await this.power(i.id).state().catch((err) => ({ available: false, error: err.message }));
        return { ...i, eula: i.eula ? { by: i.eula.by, at: i.eula.at } : null, state: { available: st.available, active: st.active || null, since: st.since || null, pending: st.pending || null, error: st.error || null } };
      }),
    );
  }

  // Creates and installs a server in the background; resolves with the ops state.
  create(wish, { user, start = false }) {
    let checked;
    try {
      checked = instances.validate({ ...wish, java: 8, build: wish.build ?? null, launch: null });
    } catch (err) {
      throw httpError(400, err.message);
    }
    if (!wish.eula) throw httpError(400, 'Accept the Minecraft EULA to create a server');
    if (fs.existsSync(path.join(this.serversDir, checked.id))) throw httpError(409, `A server named ${checked.id} already exists`);
    const { id, name, distribution, version, build, memoryMb, port, flags, autostart } = checked;
    const spec = distributions.list().find((d) => d.id === distribution);
    return this.ops.start(`Create server ${id} (${spec.name} ${version})`, user, async (step) => {
      step(`downloading ${spec.name} ${version} and Java`);
      const result = await this.jobs.run(
        'server-create',
        { id, name, distribution, version, build, memoryMb, port, flags, autostart, eula: { by: user, at: new Date().toISOString() } },
        { timeoutMs: 20 * 60 * 1000 },
      );
      if (start) {
        step('starting');
        await this.power(id).run('start');
      }
      this.onCreated?.(id, checked.kind);
      return result;
    });
  }

  async action(id, action, { user }) {
    this.get(id);
    if (!['start', 'stop', 'restart'].includes(action)) throw httpError(400, 'action must be start, stop or restart');
    const power = this.power(id);
    const st = await power.state();
    if (!st.available) throw httpError(409, `rconsole can't control ${this.unit(id)} (${st.error || 'unit not installed, see README'})`);
    if (action === 'start' && st.active === 'active') throw httpError(409, 'The server is already running');
    if (action === 'stop' && st.active !== 'active') throw httpError(409, 'The server is not running');
    const verb = { start: 'Start', stop: 'Stop', restart: 'Restart' }[action];
    return this.ops.start(`${verb} server ${id}`, user, async (step) => {
      step(`${action === 'stop' ? 'stopping' : `${action}ing`}`);
      await power.run(action);
    });
  }

  remove(id, { archive = true, user }) {
    this.get(id);
    return this.ops.start(`Delete server ${id}`, user, async (step) => {
      const power = this.power(id);
      if ((await power.state()).active === 'active') {
        step('stopping');
        await power.run('stop');
        await power.waitFor(['inactive', 'failed']);
      }
      step(archive ? 'archiving and deleting' : 'deleting');
      const result = await this.jobs.run('server-delete', { id, archive: Boolean(archive) });
      this.powers.delete(id);
      this.onDeleted?.(id);
      return result;
    });
  }

  // One console line into the server's stdin. Fails right away when nothing
  // reads the FIFO (the server isn't running).
  async send(id, command) {
    this.get(id);
    const line = String(command ?? '').trim().replace(/^\//, '');
    if (!line || line.length > COMMAND_MAX || /[\u0000-\u001f\u007f]/.test(line)) throw httpError(400, 'Enter one command line');
    let fd;
    try {
      fd = await fs.promises.open(path.join(this.fifoDir, `rconsole-mc-${id}.stdin`), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    } catch (err) {
      if (err.code === 'ENXIO' || err.code === 'ENOENT') throw httpError(409, 'The server is not running');
      throw err;
    }
    try {
      if (!(await fd.stat()).isFIFO()) throw httpError(500, 'The console is not a FIFO');
      await fd.write(`${line}\n`);
    } finally {
      await fd.close();
    }
  }

  // Starts the servers marked autostart that aren't running (after a reboot,
  // when rconsole comes up).
  async autostart() {
    for (const i of instances.list(this.serversDir)) {
      if (!i.autostart) continue;
      const power = this.power(i.id);
      const st = await power.state().catch(() => null);
      if (!st?.available || st.active === 'active' || st.active === 'activating') continue;
      this.log(`servers: autostart ${i.id}`);
      await power.run('start').catch((err) => this.log(`servers: autostart ${i.id} failed: ${err.message}`));
    }
  }
}

module.exports = { Servers };

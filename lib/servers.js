'use strict';

// The servers rconsole installed (SERVERS_DIR, lib/instances.js): list them
// with their state, create and delete them through helper jobs, start and
// stop their rconsole-mc@<id> units, and type into their console FIFO.
// rconsole itself never writes into SERVERS_DIR.

const fs = require('fs');
const path = require('path');
const instances = require('./instances');
const distributions = require('./distributions');
const { Power } = require('./power');

const COMMAND_MAX = 1000;

const httpError = (status, message) => Object.assign(new Error(message), { status });

// MB of RAM on this machine, or null.
function readMemTotalMb() {
  try {
    const kb = Number(fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemTotal:\s+(\d+)/m)?.[1]);
    return kb ? Math.floor(kb / 1024) : null;
  } catch {
    return null;
  }
}

const gb = (mb) => `${(mb / 1024).toFixed(mb % 1024 ? 1 : 0)} GB`;

class Servers {
  // limits: runs rconsole-limits.service (memory and port drop-ins for every
  // server, and the RCON firewall); null in tests and without systemd.
  constructor({ serversDir, jobs, ops, log, fifoDir = '/run', makePower = (unit) => new Power({ unit, log, resetFailed: true }), limits = null, memTotalMb = readMemTotalMb }) {
    Object.assign(this, { serversDir, jobs, ops, log, fifoDir, makePower, limits, memTotalMb });
    this.powers = new Map();
  }

  // Brings the per-server systemd limits up to date; a failure is logged,
  // the server still starts without them.
  async refreshLimits() {
    if (!this.limits) return;
    await this.limits().catch((err) => this.log(`servers: limits: ${err.message}`));
  }

  // A heap that can't fit on this machine is refused. One that fits but,
  // with the other servers, could use more than the machine has needs
  // force (the admin confirmed): only some of them may run at a time.
  checkMemory(id, memoryMb, force) {
    const total = this.memTotalMb();
    if (!total) return;
    if (memoryMb + 512 > total) throw httpError(400, `This machine has ${gb(total)} of RAM; a ${gb(memoryMb)} server won't fit. Choose less memory.`);
    const others = instances.list(this.serversDir).filter((i) => i.id !== id);
    const all = others.reduce((sum, i) => sum + instances.memoryMaxMb(i), instances.memoryMaxMb({ memoryMb }));
    if (all > total && !force) {
      throw Object.assign(httpError(409, `All servers together may use up to ${gb(all)} (heap plus Java's own memory), and this machine has ${gb(total)}. If they all run at once, the kernel stops one of them.`), { extra: { confirm: 'memory' } });
    }
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

  async list() {
    const all = instances.list(this.serversDir, (name, err) => name && this.log(`servers: skipping ${name}: ${err.message}`));
    return Promise.all(
      all.map(async (i) => {
        const st = await this.power(i.id).state().catch((err) => ({ available: false, error: err.message }));
        return { ...i, eula: i.eula ? { by: i.eula.by, at: i.eula.at } : null, state: { available: st.available, active: st.active || null, result: st.result || null, since: st.since || null, pending: st.pending || null, error: st.error || null } };
      }),
    );
  }

  // Creates and installs a server in the background; resolves with the ops state.
  create(wish, { user, start = false, force = false }) {
    let checked;
    try {
      checked = instances.validate({ ...wish, java: 8, build: wish.build ?? null, launch: null });
    } catch (err) {
      throw httpError(400, err.message);
    }
    // The Minecraft EULA covers game servers; a proxy like Velocity isn't one.
    if (checked.kind === 'server' && !wish.eula) throw httpError(400, 'Accept the Minecraft EULA to create a server');
    if (fs.existsSync(path.join(this.serversDir, checked.id))) throw httpError(409, `A server named ${checked.id} already exists`);
    if (checked.proxy) {
      const proxy = instances.list(this.serversDir).find((i) => i.id === checked.proxy);
      if (proxy?.kind !== 'proxy') throw httpError(400, `${checked.proxy} is not a proxy`);
    }
    this.checkMemory(checked.id, checked.memoryMb, force);
    const { id, name, distribution, version, build, memoryMb, port, flags, autostart, proxy, portLock, extraPorts } = checked;
    const owner = /^[A-Za-z0-9_]{3,16}$/.test(String(wish.owner || '')) ? wish.owner : null;
    const recommended = wish.recommended !== false;
    const spec = distributions.list().find((d) => d.id === distribution);
    return this.ops.start(`Create server ${id} (${spec.name} ${version})`, user, async (step) => {
      step(`downloading ${spec.name} ${version} and Java`);
      const result = await this.jobs.run(
        'server-create',
        { id, name, distribution, version, build, memoryMb, port, flags, autostart, proxy, portLock, extraPorts, recommended, owner, eula: wish.eula ? { by: user, at: new Date().toISOString() } : null },
        { timeoutMs: 20 * 60 * 1000 },
      );
      await this.refreshLimits();
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
    // Stop also ends a crash loop: between restarts the unit is activating.
    if (action === 'stop' && !['active', 'activating', 'reloading'].includes(st.active)) throw httpError(409, 'The server is not running');
    const verb = { start: 'Start', stop: 'Stop', restart: 'Restart' }[action];
    return this.ops.start(`${verb} server ${id}`, user, async (step) => {
      step(`${action === 'stop' ? 'stopping' : `${action}ing`}`);
      await power.run(action);
    });
  }

  // Memory, JVM flags, autostart and port lock; they apply at the next start.
  configure(id, changes, { user, force = false }) {
    const current = this.get(id);
    const allowed = ['memoryMb', 'flags', 'autostart', 'portLock', 'extraPorts'];
    const wish = Object.fromEntries(allowed.filter((k) => changes[k] !== undefined).map((k) => [k, changes[k]]));
    try {
      instances.validate({ ...current, ...wish });
    } catch (err) {
      throw httpError(400, err.message);
    }
    if (wish.memoryMb !== undefined && wish.memoryMb !== current.memoryMb) this.checkMemory(id, wish.memoryMb, force);
    return this.ops.start(`Change settings of ${id}`, user, async (step) => {
      step('saving');
      const result = await this.jobs.run('server-configure', { id, ...wish });
      await this.refreshLimits();
      return result;
    });
  }

  remove(id, { archive = true, user }) {
    this.get(id);
    return this.ops.start(`Delete server ${id}`, user, async (step) => {
      // Also when it's starting or waiting to restart after a crash.
      const power = this.power(id);
      const st = await power.state();
      if (st.available && !['inactive', 'failed'].includes(st.active)) {
        step('stopping');
        await power.run('stop');
        await power.waitFor(['inactive', 'failed']);
      }
      step(archive ? 'archiving and deleting' : 'deleting');
      const result = await this.jobs.run('server-delete', { id, archive: Boolean(archive) });
      await this.refreshLimits();
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
    // systemd holds the FIFO open and would start a stopped server for the
    // line; only a running server gets it.
    const st = await this.power(id).state();
    if (st.available && st.active !== 'active') throw httpError(409, 'The server is not running');
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
    // After an update to 4.3 the servers get their limits on the first start.
    await this.refreshLimits();
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

'use strict';

// Minimal client for the Source RCON protocol, as implemented by Minecraft.

const net = require('net');

const TYPE_AUTH = 3;
const TYPE_COMMAND = 2;
const MAX_FRAGMENT = 4096; // Minecraft splits responses into 4096-byte bodies
const TIMEOUT_MS = 5000;

function encodePacket(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf; // trailing two bytes are already 0x00
}

class Rcon {
  constructor({ host, port, password }) {
    Object.assign(this, { host, port, password });
    this.socket = null;
    this.connecting = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = null; // { id, type, chunks, resolve, reject, timer, idle }
    this.queue = Promise.resolve();
    this.lastError = null;
  }

  get connected() {
    return Boolean(this.socket);
  }

  connect() {
    if (this.socket) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30000);
      socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('RCON connection timed out')));

      const fail = (err) => {
        this.reset(err);
        reject(err);
      };

      socket.once('error', fail);
      socket.on('data', (data) => this.onData(data));
      socket.on('close', () => this.reset(new Error('RCON connection closed')));

      socket.once('connect', () => {
        this.socket = socket;
        socket.setTimeout(0);
        socket.off('error', fail);
        socket.on('error', (err) => this.reset(err));
        this.request(TYPE_AUTH, this.password)
          .then(() => {
            this.lastError = null;
            resolve();
          })
          .catch((err) => {
            socket.destroy();
            reject(err);
          });
      });
    })
      .catch((err) => {
        this.lastError = err.message;
        throw err;
      })
      .finally(() => {
        this.connecting = null;
      });

    return this.connecting;
  }

  reset(err) {
    if (this.socket) this.socket.destroy();
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    if (this.pending) {
      const { reject, timer, idle } = this.pending;
      clearTimeout(timer);
      clearTimeout(idle);
      this.pending = null;
      reject(err);
    }
  }

  onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0);
      if (this.buffer.length < length + 4) break;
      const id = this.buffer.readInt32LE(4);
      const type = this.buffer.readInt32LE(8);
      const body = Buffer.from(this.buffer.subarray(12, length + 2)); // decoded once all fragments are in: a character may span two
      this.buffer = this.buffer.subarray(length + 4);
      this.onPacket(id, type, body);
    }
  }

  onPacket(id, type, body) {
    const p = this.pending;
    if (!p) return;

    if (p.type === TYPE_AUTH) {
      if (type !== 2) return; // ignore the empty RESPONSE_VALUE some servers send first
      clearTimeout(p.timer);
      this.pending = null;
      if (id === -1) p.reject(new Error('RCON authentication failed (check RCON_PASSWORD)'));
      else p.resolve('');
      return;
    }

    if (id !== p.id) return;
    p.chunks.push(body);
    clearTimeout(p.idle);
    const finish = () => {
      clearTimeout(p.timer);
      this.pending = null;
      p.resolve(Buffer.concat(p.chunks).toString('utf8'));
    };
    // A full-size fragment means more may follow; wait briefly for it.
    if (body.length < MAX_FRAGMENT) finish();
    else p.idle = setTimeout(finish, 150);
  }

  request(type, body) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      if (this.nextId > 0x7fffffff) this.nextId = 1;
      const timer = setTimeout(() => this.reset(new Error('RCON request timed out')), TIMEOUT_MS);
      this.pending = { id, type, chunks: [], resolve, reject, timer, idle: null };
      this.socket.write(encodePacket(id, type, body));
    });
  }

  // Commands are serialized so each response maps to exactly one request.
  // Vanilla's own command, past plugins that replace it with another reply
  // format (EssentialsX's list and time). Paper and Spigot know them as
  // minecraft:<cmd>; vanilla, Fabric and Forge don't, so the plain name is
  // used there from the first "unknown command" on.
  async vanilla(command) {
    if (this.namespaced !== false) {
      const out = await this.send(`minecraft:${command}`);
      if (!/^Unknown (or incomplete )?command/i.test(out.trim())) {
        this.namespaced = true;
        return out;
      }
      this.namespaced = false;
    }
    return this.send(command);
  }

  send(command) {
    const run = () => this.connect().then(() => this.request(TYPE_COMMAND, command));
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result.then((out) => out.replace(/§[0-9a-fk-or]/gi, ''));
  }

  close() {
    this.reset(new Error('RCON client closed'));
  }
}

module.exports = { Rcon };

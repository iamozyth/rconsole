'use strict';

// The web listener, and changing its address without locking anyone out.
// A new address or port runs as a trial: rconsole listens on it alongside
// the old one, and keeps it only once a request arrives through it with the
// trial's token (the admin opened it, or the reverse proxy now points at
// it). Otherwise it goes back after a few minutes. Nothing is saved before
// that, so a restart in between also lands on the old address.

const http = require('http');
const crypto = require('crypto');

const TRIAL_MS = 3 * 60 * 1000;
const err = (status, msg) => Object.assign(new Error(msg), { status });

function describe(e, host, port) {
  if (e.code === 'EADDRINUSE') return `Port ${port} is already in use by another program`;
  if (e.code === 'EACCES') return `Not allowed to listen on port ${port} (ports below 1024 need CAP_NET_BIND_SERVICE, which rconsole.service grants)`;
  if (e.code === 'EADDRNOTAVAIL') return `This machine has no address ${host}`;
  return `Can't listen on ${host}:${port}: ${e.message}`;
}

class Listener {
  constructor({ handler, log = () => {}, trialMs = TRIAL_MS }) {
    Object.assign(this, { handler, log, trialMs });
    this.server = null;
    this.host = null;
    this.port = null;
    this.pending = null; // { server, host, port, token, expiresAt, swap, timer }
    this.fellBack = null; // { host, port, error } when the saved address failed at start
  }

  open(host, port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(this.handler);
      const fail = (e) => reject(Object.assign(new Error(describe(e, host, port)), { code: e.code, status: 409 }));
      server.once('error', fail);
      server.listen(port, host, () => {
        server.off('error', fail);
        server.on('error', (e) => this.log(`http: ${e.message}`));
        resolve(server);
      });
    });
  }

  // At start: the configured address, or `fallback` (the env file's) when
  // that fails, so a saved address that no longer works can't keep
  // rconsole off the network.
  async start(host, port, fallback) {
    try {
      this.server = await this.open(host, port);
      [this.host, this.port] = [host, port];
    } catch (e) {
      if (!fallback || (fallback.host === host && fallback.port === port)) throw e;
      this.log(`WARNING: ${e.message}; listening on ${fallback.host}:${fallback.port} from /etc/rconsole.env instead`);
      this.fellBack = { host, port, error: e.message };
      this.server = await this.open(fallback.host, fallback.port);
      [this.host, this.port] = [fallback.host, fallback.port];
    }
    return { host: this.host, port: this.port };
  }

  status() {
    const p = this.pending;
    return p ? { host: p.host, port: p.port, expiresAt: p.expiresAt, swap: p.swap } : null;
  }

  // Starts listening on host:port next to the current address. When both
  // can't be open at once (same port, other address), the old one closes
  // for the trial and comes back if it isn't confirmed.
  async trial(host, port) {
    if (this.pending) await this.cancel();
    if (host === this.host && port === this.port) throw err(400, `rconsole already listens on ${host}:${port}`);
    let server;
    let swap = false;
    try {
      server = await this.open(host, port);
    } catch (e) {
      if (e.code !== 'EADDRINUSE' || port !== this.port) throw e;
      swap = true;
      await this.closeServer(this.server);
      try {
        server = await this.open(host, port);
      } catch (e2) {
        this.server = await this.open(this.host, this.port);
        throw e2;
      }
    }
    const token = crypto.randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + this.trialMs;
    this.pending = { server, host, port, token, expiresAt, swap };
    this.pending.timer = setTimeout(() => this.cancel('not confirmed in time').catch((e) => this.log(`http: ${e.message}`)), this.trialMs);
    this.pending.timer.unref?.();
    this.log(`http: trying ${host}:${port}${swap ? ` (${this.host}:${this.port} closed meanwhile)` : ` next to ${this.host}:${this.port}`}, until confirmed or ${Math.round(this.trialMs / 1000)}s`);
    return { ...this.status(), token };
  }

  // Ends a trial and keeps the old address.
  async cancel(reason = 'cancelled') {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    await this.closeServer(p.server);
    if (p.swap) {
      try {
        this.server = await this.open(this.host, this.port);
      } catch (e) {
        // Neither address works: systemd restarts rconsole on the saved one.
        this.log(`http: can't go back to ${this.host}:${this.port} (${e.message}); restarting`);
        process.exit(1);
      }
    }
    this.log(`http: ${p.host}:${p.port} ${reason}; staying on ${this.host}:${this.port}`);
  }

  // A request carrying the token arrived on `socketServer`: keep the trial
  // address if it came through it. Returns the address to save.
  confirm(token, socketServer) {
    const p = this.pending;
    if (!p || typeof token !== 'string' || token.length !== p.token.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(p.token))) throw err(404, 'No address change is waiting for confirmation');
    if (socketServer !== p.server) throw err(409, `Not confirmed: this request came through ${this.host}:${this.port}, not the new ${p.host}:${p.port}`);
    this.pending = null;
    clearTimeout(p.timer);
    const old = p.swap ? null : this.server;
    [this.server, this.host, this.port] = [p.server, p.host, p.port];
    this.fellBack = null;
    // After this answer is on its way.
    if (old) setTimeout(() => this.closeServer(old), 1000).unref?.();
    this.log(`http: now listening on ${p.host}:${p.port}`);
    return { host: p.host, port: p.port };
  }

  closeServer(server) {
    return new Promise((resolve) => {
      if (!server?.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  async close() {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      await this.closeServer(this.pending.server);
      this.pending = null;
    }
    await this.closeServer(this.server);
  }
}

module.exports = { Listener, TRIAL_MS };

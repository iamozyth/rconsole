'use strict';

// Follows logs/latest.log, surviving the rotation Minecraft does on startup.

const fs = require('fs');
const { EventEmitter } = require('events');

const BACKLOG_LINES = 300;
const INITIAL_BYTES = 64 * 1024;
const POLL_MS = 1000;

class LogTail extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.ino = null;
    this.pos = 0;
    this.partial = '';
    this.backlog = [];
    this.reading = false;
    this.error = null;
    this.setMaxListeners(0);
  }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  stop() {
    clearInterval(this.timer);
  }

  async poll() {
    if (this.reading) return;
    this.reading = true;
    try {
      const stat = await fs.promises.stat(this.file);
      if (this.ino === null) {
        // First read: start near the end and drop the cut-off first line.
        this.pos = Math.max(0, stat.size - INITIAL_BYTES);
        this.skipFirst = this.pos > 0;
      } else if (stat.ino !== this.ino || stat.size < this.pos) {
        this.pos = 0;
        this.partial = '';
        this.push('──── log rotated (server restarted) ────');
      }
      this.ino = stat.ino;
      this.setError(null);
      if (stat.size > this.pos) await this.read(stat.size);
    } catch (err) {
      this.setError(err.code === 'ENOENT' ? `Log file not found: ${this.file}` : err.message);
    } finally {
      this.reading = false;
    }
  }

  async read(size) {
    const fh = await fs.promises.open(this.file, 'r');
    try {
      const buf = Buffer.alloc(size - this.pos);
      const { bytesRead } = await fh.read(buf, 0, buf.length, this.pos);
      this.pos += bytesRead;
      const lines = (this.partial + buf.subarray(0, bytesRead).toString('utf8')).split('\n');
      this.partial = lines.pop();
      if (this.skipFirst) {
        lines.shift();
        this.skipFirst = false;
      }
      for (const line of lines) this.push(line.replace(/\r$/, ''));
    } finally {
      await fh.close();
    }
  }

  setError(error) {
    if (error === this.error) return;
    this.error = error;
    this.emit('status', error);
  }

  push(line) {
    this.backlog.push(line);
    if (this.backlog.length > BACKLOG_LINES) this.backlog.shift();
    this.emit('line', line);
  }
}

module.exports = { LogTail };

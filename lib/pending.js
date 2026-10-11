'use strict';

// Changes that only take effect after the next server start (settings that
// can't be applied live, plugin changes). Cleared once the server has been
// (re)started after the change.

const fs = require('fs');
const path = require('path');

class Pending {
  constructor({ stateDir, power }) {
    this.file = path.join(stateDir, 'pending-restart.json');
    this.power = power;
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return [];
    }
  }

  add(what) {
    const items = this.read().filter((i) => i.what !== what);
    items.push({ what, at: new Date().toISOString() });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(items));
  }

  async list() {
    const items = this.read();
    if (!items.length) return [];
    const st = await this.power.state();
    const since = st.active === 'active' && st.since ? Date.parse(st.since) : null;
    const open = since ? items.filter((i) => Date.parse(i.at) > since) : items;
    if (open.length !== items.length) fs.writeFileSync(this.file, JSON.stringify(open));
    return open.map((i) => i.what);
  }
}

module.exports = { Pending };

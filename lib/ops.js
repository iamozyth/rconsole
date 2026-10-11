'use strict';

// One disruptive operation at a time (world switch, restore, power with a
// countdown...). Progress is exposed through `state` for the UI.

class Ops {
  constructor({ log }) {
    this.log = log;
    this.current = null;
    this.state = { running: false, label: null, step: null, user: null, startedAt: null, finishedAt: null, error: null, result: null };
  }

  busy() {
    return Boolean(this.current);
  }

  // Starts `fn(step)` in the background and returns the initial state.
  start(label, user, fn) {
    if (this.current) throw Object.assign(new Error(`Busy: ${this.state.label} (${this.state.step})`), { status: 409 });
    this.state = { running: true, label, step: 'starting', user, startedAt: new Date().toISOString(), finishedAt: null, error: null, result: null };
    this.log(`op: ${user} started "${label}"`);
    const step = (name) => {
      this.state.step = name;
      this.log(`op: ${label}: ${name}`);
    };
    this.current = Promise.resolve()
      .then(() => fn(step))
      .then((result) => {
        this.state.result = result ?? null;
        this.log(`op: "${label}" done`);
      })
      .catch((err) => {
        this.state.error = err.message;
        this.log(`op: "${label}" failed: ${err.message}`);
      })
      .finally(() => {
        this.state.running = false;
        this.state.finishedAt = new Date().toISOString();
        this.current = null;
        this.onFinish?.(this.state);
      });
    return this.state;
  }
}

module.exports = { Ops };

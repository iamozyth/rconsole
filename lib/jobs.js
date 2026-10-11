'use strict';

// Runs privileged helper jobs (bin/mc-helper.js) as the Minecraft user by
// starting the rconsole-<kind>@<instance>.service units. polkit allows the
// rconsole user to start exactly these units and nothing else.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const INSTANCE_RE = /^[A-Za-z0-9._-]{1,64}$/;

function exec(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => resolve({ code: -1, out: err.message }));
    child.on('close', (code) => resolve({ code, out: out.trim() }));
  });
}

class Jobs {
  constructor({ backupDir, runner }) {
    this.dir = path.join(backupDir, '.jobs');
    this.runner = runner;
  }

  resultFile(kind, instance) {
    return path.join(this.dir, `${kind}-${instance}.json`);
  }

  readResult(kind, instance) {
    try {
      return JSON.parse(fs.readFileSync(this.resultFile(kind, instance), 'utf8'));
    } catch {
      return null;
    }
  }

  // Resolves with the helper's result object, rejects with its error message.
  async run(kind, instance, { timeoutMs = 30 * 60 * 1000 } = {}) {
    if (!['backup', 'update'].includes(kind) || !INSTANCE_RE.test(instance)) throw new Error('Invalid job');
    // rconsole can only read the jobs directory, so stale results are told
    // apart by time rather than deleted.
    const startedAt = Date.now() - 1000;

    const unit = `rconsole-${kind}@${instance}.service`;
    const { code, out } =
      this.runner === 'direct'
        ? await exec(process.execPath, [path.join(__dirname, '..', 'bin', 'mc-helper.js'), kind, instance], timeoutMs)
        : await exec('systemctl', ['start', unit], timeoutMs);

    let result = this.readResult(kind, instance);
    if (result && !(Date.parse(result.finished) >= startedAt)) result = null;
    if (result?.ok) return result;
    if (result?.error) throw new Error(result.error);
    if (/interactive authentication|access denied|not authorized/i.test(out)) {
      throw new Error(`Not allowed to start ${unit}. Install the polkit rule (see README).`);
    }
    if (/not found|does not exist/i.test(out)) throw new Error(`${unit} is not installed (see README).`);
    throw new Error(out || `${unit} failed (exit ${code}). See: journalctl -u ${unit}`);
  }

  // The newest successful update, for showing the installed build.
  lastInstalled() {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => /^update-[\d.]+_\d+\.json$/.test(f))
        .map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')))
        .filter((r) => r.ok)
        .sort((a, b) => String(b.finished).localeCompare(String(a.finished)))[0] || null;
    } catch {
      return null;
    }
  }
}

module.exports = { Jobs };

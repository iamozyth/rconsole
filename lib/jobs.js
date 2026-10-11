'use strict';

// Runs privileged helper jobs (bin/mc-helper.js) as the Minecraft user.
// rconsole writes BACKUP_DIR/.requests/<id>.json and starts
// rconsole-job@<id> (offline) or rconsole-net@<id> (network); polkit lets the
// rconsole user start exactly these units. The helper validates the request
// again and writes BACKUP_DIR/.jobs/<id>.json.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const NETWORK_KINDS = new Set(['paper-update', 'plugin-install', 'plugin-update']);

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
  constructor({ backupDir, runner, log = () => {} }) {
    this.requests = path.join(backupDir, '.requests');
    this.results = path.join(backupDir, '.jobs');
    this.runner = runner;
    this.log = log;
  }

  writeRequest(id, kind, args) {
    // rconsole runs with UMask=0077 and its own primary group; the helper
    // (minecraft) reads through the group that owns BACKUP_DIR. chmod clears
    // the setgid bit, so group ownership is set explicitly on dir and file.
    const gid = fs.statSync(path.dirname(this.requests)).gid;
    fs.mkdirSync(this.requests, { recursive: true });
    fs.chownSync(this.requests, -1, gid);
    fs.chmodSync(this.requests, 0o750);
    const file = path.join(this.requests, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ kind, args, requested: new Date().toISOString() }), { mode: 0o600 });
    fs.chownSync(file, -1, gid);
    fs.chmodSync(file, 0o640);
    return file;
  }

  // Resolves with the helper's result object, rejects with its error message.
  async run(kind, args = {}, { timeoutMs = 30 * 60 * 1000 } = {}) {
    const id = crypto.randomBytes(16).toString('hex');
    const requestFile = this.writeRequest(id, kind, args);
    const unit = `${NETWORK_KINDS.has(kind) ? 'rconsole-net' : 'rconsole-job'}@${id}.service`;
    try {
      const { code, out } =
        this.runner === 'direct'
          ? await exec(process.execPath, [path.join(__dirname, '..', 'bin', 'mc-helper.js'), 'job', id], timeoutMs)
          : await exec('systemctl', ['start', unit], timeoutMs);

      let result = null;
      try {
        result = JSON.parse(fs.readFileSync(path.join(this.results, `${id}.json`), 'utf8'));
      } catch {}
      if (result?.ok) return result;
      if (result?.error) throw new Error(result.error);
      if (/interactive authentication|access denied|not authorized/i.test(out)) {
        throw new Error(`Not allowed to start ${unit}. Install the polkit rule (see README).`);
      }
      if (/not found|does not exist/i.test(out)) throw new Error(`${unit.replace(/@.*/, '@')} is not installed (see README).`);
      throw new Error(out || `${unit} failed (exit ${code}). See: journalctl -u ${unit}`);
    } finally {
      fs.rmSync(requestFile, { force: true });
    }
  }

  // The newest successful Paper update, for showing the installed build when
  // the log doesn't say.
  lastInstalled() {
    try {
      return fs
        .readdirSync(this.results)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          try {
            return JSON.parse(fs.readFileSync(path.join(this.results, f), 'utf8'));
          } catch {
            return null;
          }
        })
        .filter((r) => r?.ok && r.version && r.build)
        .sort((a, b) => String(b.finished).localeCompare(String(a.finished)))[0] || null;
    } catch {
      return null;
    }
  }
}

module.exports = { Jobs, NETWORK_KINDS };

'use strict';

// rconsole's own settings, changed under Settings → System and kept in
// STATE_DIR/system.json (mode 0600). A value saved there wins over
// /etc/rconsole.env; "Reset" removes it so the env file applies again.
// Paths, RCON and anything a root-owned unit reads (RCON_FIREWALL,
// SELF_UPDATE_SIGNERS) stay in the env file only: a stolen admin session
// must not be able to move the sandbox or switch off a safeguard.

const fs = require('fs');
const net = require('net');
const path = require('path');

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const list = (s) => (Array.isArray(s) ? s : String(s ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);
const OFF = /^(off|false|0|no)$/i;

// env: the variable in /etc/rconsole.env. fromEnv turns its text into a
// value (a bad one falls back to the default, as before); parse validates
// what the form sends and throws a readable reason.
const FIELDS = {
  webHost: {
    env: 'WEB_HOST',
    default: '127.0.0.1',
    fromEnv: (s) => s,
    parse(v) {
      const s = String(v ?? '').trim().replace(/^\[(.*)\]$/, '$1');
      if (s !== 'localhost' && !net.isIP(s)) throw bad('Address: an IP address such as 0.0.0.0 (all), 127.0.0.1 (this machine only) or ::');
      return s;
    },
  },
  webPort: {
    env: 'WEB_PORT',
    default: 8080,
    fromEnv: (s) => Number(s) || 8080,
    parse(v) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw bad('Port: a whole number from 1 to 65535');
      return n;
    },
  },
  trustProxy: {
    env: 'TRUST_PROXY',
    default: [],
    fromEnv: list,
    parse(v) {
      const ips = [...new Set(list(v).map((s) => s.replace(/^::ffff:/, '')))];
      const wrong = ips.find((s) => !net.isIP(s));
      if (wrong) throw bad(`Trusted proxies: "${wrong.slice(0, 60)}" is not an IP address`);
      if (ips.length > 10) throw bad('Trusted proxies: at most 10');
      return ips;
    },
  },
  require2fa: {
    env: 'REQUIRE_2FA',
    default: 'off',
    fromEnv: (s) => (['admin', 'all'].includes(String(s).toLowerCase()) ? String(s).toLowerCase() : 'off'),
    parse(v) {
      if (!['off', 'admin', 'all'].includes(v)) throw bad('Two-factor sign-in: off, admin or all');
      return v;
    },
  },
  metricsToken: {
    env: 'METRICS_TOKEN',
    default: '',
    secret: true,
    fromEnv: (s) => s,
    parse(v) {
      const s = String(v ?? '');
      if (s && !/^[\x21-\x7e]{16,200}$/.test(s)) throw bad('Metrics token: 16 to 200 characters, no spaces');
      return s;
    },
  },
  backupKeep: {
    env: 'BACKUP_KEEP',
    default: 10,
    fromEnv: (s) => (Number.isInteger(Number(s)) && Number(s) >= 0 ? Number(s) : 10),
    parse(v) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 1000) throw bad('Backups to keep: 0 (all) to 1000');
      return n;
    },
  },
  backupCompression: {
    env: 'BACKUP_COMPRESSION',
    default: 'auto',
    fromEnv: (s) => (/^gz(ip)?$/i.test(s) ? 'gzip' : 'auto'),
    parse(v) {
      if (!['auto', 'gzip'].includes(v)) throw bad('Backup compression: auto or gzip');
      return v;
    },
  },
  updateCheck: {
    env: 'SELF_UPDATE_CHECK',
    default: true,
    fromEnv: (s) => s !== '0' && !OFF.test(s),
    parse(v) {
      if (typeof v !== 'boolean') throw bad('Update check: true or false');
      return v;
    },
  },
};

// The listener fields: changed through a trial (lib/listener.js), not saved directly.
const LISTEN = new Set(['webHost', 'webPort']);

const fileOf = (stateDir) => path.join(stateDir, 'system.json');

function readSaved(stateDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(stateDir), 'utf8'));
    const out = {};
    // A value edited by hand that no longer validates is ignored, not fatal.
    for (const [k, v] of Object.entries(raw || {})) {
      if (!FIELDS[k]) continue;
      try {
        out[k] = FIELDS[k].parse(v);
      } catch {}
    }
    return out;
  } catch {
    return {};
  }
}

function fromEnv(env) {
  const out = {};
  for (const [k, f] of Object.entries(FIELDS)) {
    const has = env[f.env] !== undefined && env[f.env] !== '';
    out[k] = { set: has, value: has ? f.fromEnv(env[f.env]) : f.default };
  }
  return out;
}

// What applies: saved, then the env file, then the default.
function effective(env, saved) {
  const e = fromEnv(env);
  return Object.fromEntries(Object.keys(FIELDS).map((k) => [k, k in saved ? saved[k] : e[k].value]));
}

class SystemSettings {
  constructor({ stateDir, env = process.env }) {
    this.stateDir = stateDir;
    this.env = env;
    this.saved = readSaved(stateDir);
  }

  get values() {
    return effective(this.env, this.saved);
  }

  // For the form: each value with where it comes from. Secrets only say whether they're set.
  view() {
    const e = fromEnv(this.env);
    const out = {};
    for (const [k, f] of Object.entries(FIELDS)) {
      const source = k in this.saved ? 'saved' : e[k].set ? 'env' : 'default';
      const value = source === 'saved' ? this.saved[k] : e[k].value;
      const envValue = e[k].set ? e[k].value : null;
      out[k] = f.secret
        ? { set: Boolean(value), source, envSet: Boolean(envValue), env: f.env }
        : { value, source, envValue, default: f.default, env: f.env };
    }
    return out;
  }

  // Validates a change: { set: { key: value }, reset: [key] }. Returns the
  // next saved object and the keys whose effective value changes.
  next({ set = {}, reset = [] } = {}) {
    if (typeof set !== 'object' || Array.isArray(set) || !Array.isArray(reset)) throw bad('Bad request');
    const n = { ...this.saved };
    for (const k of reset) {
      if (!FIELDS[k]) throw bad(`Unknown setting ${String(k).slice(0, 40)}`);
      delete n[k];
    }
    for (const [k, v] of Object.entries(set)) {
      if (!FIELDS[k]) throw bad(`Unknown setting ${String(k).slice(0, 40)}`);
      n[k] = FIELDS[k].parse(v);
    }
    const before = this.values;
    const after = effective(this.env, n);
    const changed = Object.keys(FIELDS).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    return { saved: n, values: after, changed };
  }

  save(saved) {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const file = fileOf(this.stateDir);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(saved, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    this.saved = saved;
  }
}

module.exports = { SystemSettings, FIELDS, LISTEN, readSaved, effective, fromEnv, fileOf };

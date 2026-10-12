'use strict';

// Users (scrypt password hashes + optional TOTP), sessions and login throttling.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

function scrypt(password, salt, params) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, KEYLEN, params, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(actual, expected);
}

// Verifying against this when the user doesn't exist keeps timing uniform.
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await hashPassword(crypto.randomBytes(16).toString('hex')));

// ---------------------------------------------------------------------------
// TOTP (RFC 6238, SHA-1, 6 digits, 30 s)
// ---------------------------------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// Returns the matching time step, or null. Accepts ±1 step of clock drift.
function verifyTotp(secret, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const step = Math.floor(now / 30000);
  for (const s of [step, step - 1, step + 1]) {
    const expected = Buffer.from(hotp(secret, s));
    if (crypto.timingSafeEqual(expected, Buffer.from(String(code)))) return s;
  }
  return null;
}

const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
const totpUri = (user, secret) =>
  `otpauth://totp/rconsole:${encodeURIComponent(user)}?secret=${secret}&issuer=rconsole&algorithm=SHA1&digits=6&period=30`;

// ---------------------------------------------------------------------------
// User store (users.json in the state directory)
// ---------------------------------------------------------------------------

const USERNAME_RE = /^[a-z0-9_.-]{2,32}$/i;

class Users {
  constructor(stateDir) {
    this.file = path.join(stateDir, 'users.json');
    this.users = {};
    this.mtime = 0;
  }

  // Re-read when the CLI changed the file, so no restart is needed.
  load() {
    try {
      const { mtimeMs } = fs.statSync(this.file);
      if (mtimeMs !== this.mtime) {
        this.users = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.mtime = mtimeMs;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.users = {};
    }
    return this.users;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.users, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(name) {
    return this.load()[String(name).toLowerCase()] || null;
  }

  get count() {
    return Object.keys(this.load()).length;
  }

  async setPassword(name, password) {
    name = String(name).toLowerCase();
    if (!USERNAME_RE.test(name)) throw new Error('Username: 2-32 chars, letters, digits, . _ -');
    if (String(password).length < 10) throw new Error('Password must be at least 10 characters');
    this.load();
    const existing = this.users[name] || { created: new Date().toISOString(), totp: null };
    this.users[name] = { ...existing, hash: await hashPassword(password), changed: new Date().toISOString() };
    this.save();
  }

  setTotp(name, secret) {
    this.load();
    const user = this.users[String(name).toLowerCase()];
    if (!user) throw new Error(`No such user: ${name}`);
    user.totp = secret;
    // Turning 2FA on or off ends existing sessions, like a password change.
    user.changed = new Date().toISOString();
    this.save();
  }

  remove(name) {
    this.load();
    if (!this.users[String(name).toLowerCase()]) throw new Error(`No such user: ${name}`);
    delete this.users[String(name).toLowerCase()];
    this.save();
  }
}

// ---------------------------------------------------------------------------
// Login throttling: 5 failures per IP or per username within 15 min → 15 min lockout
// ---------------------------------------------------------------------------

class Throttle {
  constructor({ max = 5, windowMs = 15 * 60 * 1000 } = {}) {
    Object.assign(this, { max, windowMs });
    this.hits = new Map();
    setInterval(() => this.sweep(), 60 * 1000).unref();
  }

  key(k) {
    const now = Date.now();
    const list = (this.hits.get(k) || []).filter((t) => now - t < this.windowMs);
    this.hits.set(k, list);
    return list;
  }

  // Seconds until the key may try again, or 0.
  blocked(...keys) {
    let wait = 0;
    for (const k of keys) {
      const list = this.key(k);
      if (list.length >= this.max) wait = Math.max(wait, Math.ceil((list[0] + this.windowMs - Date.now()) / 1000));
    }
    return wait;
  }

  fail(...keys) {
    for (const k of keys) this.key(k).push(Date.now());
  }

  reset(...keys) {
    for (const k of keys) this.hits.delete(k);
  }

  sweep() {
    for (const k of this.hits.keys()) if (!this.key(k).length) this.hits.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Sessions (in memory; a restart of rconsole signs everyone out)
// ---------------------------------------------------------------------------

const IDLE_MS = 12 * 60 * 60 * 1000;
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;

class Sessions {
  constructor() {
    this.map = new Map(); // sha256(token) -> { user, created, seen, csrf }
    setInterval(() => this.sweep(), 10 * 60 * 1000).unref();
  }

  static digest(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  create(user) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.map.set(Sessions.digest(token), { user, created: now, seen: now });
    return token;
  }

  get(token) {
    if (!token) return null;
    const key = Sessions.digest(token);
    const s = this.map.get(key);
    if (!s) return null;
    const now = Date.now();
    if (now - s.seen > IDLE_MS || now - s.created > ABSOLUTE_MS) {
      this.map.delete(key);
      return null;
    }
    s.seen = now;
    return s;
  }

  destroy(token) {
    if (token) this.map.delete(Sessions.digest(token));
  }

  destroyUser(user) {
    for (const [k, s] of this.map) if (s.user === user) this.map.delete(k);
  }

  sweep() {
    const now = Date.now();
    for (const [k, s] of this.map) if (now - s.seen > IDLE_MS || now - s.created > ABSOLUTE_MS) this.map.delete(k);
  }
}

module.exports = {
  Users, Sessions, Throttle,
  hashPassword, verifyPassword, getDummyHash,
  verifyTotp, newTotpSecret, totpUri, hotp,
  IDLE_MS,
};

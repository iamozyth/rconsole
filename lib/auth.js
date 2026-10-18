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

// Recovery codes: one-time stand-ins for the TOTP code when the phone is
// gone. 50 random bits each, so a fast hash is enough to store them.
const RECOVERY_RE = /^[A-Z2-7]{5}-?[A-Z2-7]{5}$/;
const hashRecovery = (code) => crypto.createHash('sha256').update(String(code).toUpperCase().replace(/-/g, '')).digest('hex');
function newRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const c = base32Encode(crypto.randomBytes(7)).slice(0, 10);
    return `${c.slice(0, 5)}-${c.slice(5)}`;
  });
}
const totpUri = (user, secret) =>
  `otpauth://totp/rconsole:${encodeURIComponent(user)}?secret=${secret}&issuer=rconsole&algorithm=SHA1&digits=6&period=30`;

// ---------------------------------------------------------------------------
// User store (users.json in the state directory)
// ---------------------------------------------------------------------------

const ROLES = ['viewer', 'moderator', 'admin'];
const roleAtLeast = (role, min) => ROLES.indexOf(role) >= ROLES.indexOf(min);
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
    // `sudo node cli.js …` runs as root: hand the file to the state
    // directory's owner (rconsole), or rconsole can't read it and won't start.
    if (process.getuid?.() === 0) {
      const { uid, gid } = fs.statSync(path.dirname(this.file));
      fs.chownSync(tmp, uid, gid);
    }
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
    if (this.users[name]?.sso) throw new Error(`${name} signs in through single sign-on and has no password here`);
    const existing = this.users[name] || { created: new Date().toISOString(), totp: null };
    this.users[name] = { ...existing, hash: await hashPassword(password), changed: new Date().toISOString() };
    this.save();
  }

  // admin: everything. moderator: players, chat and moderation commands.
  // viewer: read-only. Accounts from before roles existed are admins.
  roleOf(name) {
    const role = this.get(name)?.role;
    return ROLES.includes(role) ? role : 'admin';
  }

  setRole(name, role) {
    if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`);
    this.load();
    const user = this.users[String(name).toLowerCase()];
    if (!user) throw new Error(`No such user: ${name}`);
    user.role = role;
    user.changed = new Date().toISOString(); // signs the user out, so the new role applies at once
    this.save();
  }

  // recovery: the plain codes to store (hashed), given with a new secret.
  setTotp(name, secret, recovery = []) {
    this.load();
    const user = this.users[String(name).toLowerCase()];
    if (!user) throw new Error(`No such user: ${name}`);
    user.totp = secret;
    user.recovery = secret ? recovery.map(hashRecovery) : undefined;
    // Turning 2FA on or off ends existing sessions, like a password change.
    user.changed = new Date().toISOString();
    this.save();
  }

  // Uses up a recovery code; true when it was one of the user's.
  useRecovery(name, code) {
    if (!RECOVERY_RE.test(String(code).toUpperCase())) return false;
    this.load();
    const user = this.users[String(name).toLowerCase()];
    const h = hashRecovery(code);
    const i = (user?.recovery || []).findIndex((x) => x.length === h.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(h)));
    if (i < 0) return false;
    user.recovery.splice(i, 1);
    this.save();
    return true;
  }

  // The account a provider user signed in to before, by (issuer, subject).
  findSso(iss, sub) {
    for (const [name, u] of Object.entries(this.load())) if (u.sso && u.sso.iss === iss && u.sso.sub === sub) return name;
    return null;
  }

  // Creates or updates the account for a provider user and returns its name.
  // SSO accounts have no password; they never take over a local account of
  // the same name (that one keeps its name, the new one gets a suffix).
  upsertSso({ iss, sub, username, name, email, role }) {
    if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`);
    this.load();
    let key = this.findSso(iss, sub);
    const now = new Date().toISOString();
    if (!key) {
      const base = (String(username || email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 28) || 'user').padEnd(2, '0');
      key = base;
      for (let i = 2; this.users[key]; i++) key = `${base}-${i}`;
      this.users[key] = { created: now, changed: now, role, sso: { iss, sub } };
    }
    const user = this.users[key];
    if (user.role !== role) {
      user.role = role;
      user.changed = now; // the old role's sessions end
    }
    user.sso = { iss, sub, name: name ? String(name).slice(0, 100) : undefined, email: email ? String(email).slice(0, 200) : undefined };
    user.lastLogin = now;
    this.save();
    return key;
  }

  remove(name) {
    this.load();
    if (!this.users[String(name).toLowerCase()]) throw new Error(`No such user: ${name}`);
    delete this.users[String(name).toLowerCase()];
    this.save();
  }
}

// ---------------------------------------------------------------------------
// Login throttling: 5 failures per key within 15 min → 15 min lockout (keys: see login() in server.js)
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
// Sessions: in memory, and in STATE_DIR/sessions.json (only the SHA-256 of
// each token) so restarting rconsole (switching servers, updating) doesn't
// sign everyone out.
// ---------------------------------------------------------------------------

const IDLE_MS = 12 * 60 * 60 * 1000;
const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
const SEEN_SAVE_MS = 5 * 60 * 1000; // "last seen" only needs to survive a restart roughly

class Sessions {
  constructor(file = null) {
    this.file = file;
    this.map = new Map(); // sha256(token) -> { user, created, seen, via, idToken, maxAge }
    this.timer = null;
    this.load();
    setInterval(() => this.sweep(), 10 * 60 * 1000).unref();
  }

  load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [k, s] of Object.entries(data)) if (/^[a-f0-9]{64}$/.test(k) && s && typeof s.user === 'string') this.map.set(k, s);
      this.sweep();
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`sessions: ignoring ${this.file}: ${err.message}`);
    }
  }

  // Coalesces bursts of changes into one write.
  changed() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 1000);
    this.timer.unref();
  }

  flush() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = null;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`sessions: can't save ${this.file}: ${err.message}`);
    }
  }

  static digest(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  // via: 'password' or 'sso'; maxAge (ms) shortens the absolute lifetime,
  // so an SSO session ends within hours of losing access at the provider.
  create(user, { via = 'password', idToken = null, maxAge = ABSOLUTE_MS } = {}) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.map.set(Sessions.digest(token), { user, created: now, seen: now, via, idToken, maxAge: Math.min(maxAge, ABSOLUTE_MS) });
    this.changed();
    return token;
  }

  get(token) {
    if (!token) return null;
    const key = Sessions.digest(token);
    const s = this.map.get(key);
    if (!s) return null;
    const now = Date.now();
    if (now - s.seen > IDLE_MS || now - s.created > (s.maxAge ?? ABSOLUTE_MS)) {
      this.map.delete(key);
      this.changed();
      return null;
    }
    if (now - (s.saved ?? s.seen) > SEEN_SAVE_MS) {
      s.saved = now;
      this.changed();
    }
    s.seen = now;
    return s;
  }

  destroy(token) {
    if (token && this.map.delete(Sessions.digest(token))) this.changed();
  }

  destroyUser(user) {
    for (const [k, s] of this.map) if (s.user === user && this.map.delete(k)) this.changed();
  }

  sweep() {
    const now = Date.now();
    for (const [k, s] of this.map) if (now - s.seen > IDLE_MS || now - s.created > (s.maxAge ?? ABSOLUTE_MS)) this.map.delete(k) && this.changed();
  }
}

module.exports = {
  Users, Sessions, Throttle,
  hashPassword, verifyPassword, getDummyHash,
  verifyTotp, newTotpSecret, totpUri, hotp, ROLES, roleAtLeast, newRecoveryCodes,
  IDLE_MS,
};

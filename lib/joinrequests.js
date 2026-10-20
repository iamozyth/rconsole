'use strict';

// Knock to join: a player who isn't whitelisted tries to join, and the
// owner gets a request to allow with one tap (in rconsole or from the
// notification). Invite links go the other way: a friend opens the link,
// types their Minecraft name and lands in the same list, or on the
// whitelist right away if the invite says so.
//
// Requests come from the log of the server rconsole shows: a disconnect
// whose reason is the whitelist message (with the UUID from the "UUID of
// player" line before it, when there is one). Stored in STATE_DIR/join.json with
// the invites; invite tokens are kept as SHA-256 hashes only, so the link is
// shown once when it is made.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseLine } = require('./logfiles');
const { pickEvent } = require('./players');

const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
// Vanilla: "You are not white-listed on this server!", Paper: "whitelisted".
const WHITELIST_RE = /white-?list/i;
const UUID_FRESH_MS = 60 * 1000; // the UUID line comes right before the disconnect
const KEEP = 200;
const PENDING_DAYS = 14;
const DAY = 24 * 3600 * 1000;
const hash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const bad = (status, msg) => Object.assign(new Error(msg), { status });

class JoinRequests {
  // send(server, command) -> reply text; server: the key requests belong to.
  constructor({ stateDir, server = null, send, mcDir = null, log = () => {}, lookup = mojangLookup, onRequest = () => {}, onResolved = () => {}, now = Date.now }) {
    this.file = path.join(stateDir, 'join.json');
    this.server = server;
    this.sendCommand = send;
    this.mcDir = mcDir;
    this.log = log;
    this.lookup = lookup;
    this.onRequest = onRequest;
    this.onResolved = onResolved;
    this.now = now;
    this.uuids = new Map(); // lowercase name -> { uuid, t } from "UUID of player"
    this.ready = false; // lines replayed by the log tail at startup don't count
    this.customMessage = readWhitelistMessage(mcDir);
    this.data = this.load();
    this.publicHits = new Map(); // ip -> [times] for the invite page
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { requests: Array.isArray(d.requests) ? d.requests : [], invites: Array.isArray(d.invites) ? d.invites : [] };
    } catch {
      return { requests: [], invites: [] };
    }
  }

  save() {
    const now = this.now();
    // Old pending requests expire; handled ones are kept as recent history.
    for (const r of this.data.requests) if (r.status === 'pending' && now - Date.parse(r.last) > PENDING_DAYS * DAY) r.status = 'expired';
    this.data.requests = this.data.requests.slice(-KEEP);
    this.data.invites = this.data.invites.filter((i) => !i.revoked && !(i.expires && Date.parse(i.expires) < now - 7 * DAY));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // A disconnect for not being whitelisted. In online mode the server checks
  // the whitelist only after Mojang vouched for the account, so it is a real
  // player; offline and behind a proxy there's no "UUID of player" line, so
  // that line is used when present but not required.
  isKnock(name, reason) {
    return Boolean(name && NAME_RE.test(name) && this.matchesReason(reason));
  }

  matchesReason(reason) {
    const r = String(reason || '');
    if (WHITELIST_RE.test(r)) return true;
    return Boolean(this.customMessage && r.trim() === this.customMessage);
  }

  onLogLine(line) {
    const p = parseLine(line);
    const e = p && pickEvent(p);
    if (!e) return;
    if (e.type === 'uuid') {
      this.uuids.set(e.name.toLowerCase(), { uuid: e.extra, t: this.now() });
      if (this.uuids.size > 500) this.uuids.delete(this.uuids.keys().next().value);
      return;
    }
    if (e.type !== 'attempt' || !this.ready || !this.isKnock(e.name, e.extra?.reason)) return;
    const u = this.uuids.get(e.name.toLowerCase());
    this.knock({ name: e.name, uuid: u && this.now() - u.t < UUID_FRESH_MS ? u.uuid : null, ip: e.extra.ip });
  }

  // A player knocked: new request, or the same one again (count goes up).
  knock({ name, uuid = null, ip = null, via = 'knock', invite = null }) {
    const nowIso = new Date(this.now()).toISOString();
    let r = this.data.requests.find((x) => x.server === this.server && x.name.toLowerCase() === name.toLowerCase() && x.status === 'pending');
    const fresh = !r;
    if (r) {
      // Paper logs "Disconnecting X" and "X lost connection" for one try.
      if (this.now() - Date.parse(r.last) > 5000) r.count++;
      r.last = nowIso;
      if (uuid) r.uuid = uuid;
      if (ip) r.ip = ip;
    } else {
      // Ignored before: counted, but no new request (and no new alert) for a week.
      const ignored = this.data.requests.findLast((x) => x.server === this.server && x.name.toLowerCase() === name.toLowerCase() && x.status === 'ignored');
      if (ignored && via === 'knock' && this.now() - Date.parse(ignored.at) < 7 * DAY) {
        if (this.now() - Date.parse(ignored.last) > 5000) ignored.count++;
        ignored.last = nowIso;
        this.save();
        return ignored;
      }
      r = { id: crypto.randomBytes(8).toString('hex'), server: this.server, name, uuid, ip, first: nowIso, last: nowIso, count: 1, status: 'pending', via, invite };
      this.data.requests.push(r);
    }
    this.save();
    if (fresh) this.onRequest(r);
    return r;
  }

  get(id) {
    const r = this.data.requests.find((x) => x.id === id);
    if (!r) throw bad(404, 'No such join request');
    return r;
  }

  async allow(id, by) {
    const r = this.get(id);
    if (r.status === 'allowed') return r;
    if (r.server !== this.server) throw bad(409, 'This request is for another server; show that server to answer it');
    const reply = String(await this.sendCommand(r.server, `whitelist add ${r.name}`) ?? '');
    // "Added X to the whitelist", "Player is already whitelisted"; anything about a missing player is a failure.
    if (/does not exist|unknown|couldn't|could not|not found/i.test(reply)) throw bad(502, `The server didn't whitelist ${r.name}: ${reply.trim().slice(0, 200)}`);
    Object.assign(r, { status: 'allowed', by, at: new Date(this.now()).toISOString() });
    this.save();
    this.log(`join: ${by} allowed ${r.name}`);
    this.onResolved(r);
    return r;
  }

  ignore(id, by) {
    const r = this.get(id);
    if (r.status !== 'pending') return r;
    Object.assign(r, { status: 'ignored', by, at: new Date(this.now()).toISOString() });
    this.save();
    this.onResolved(r);
    return r;
  }

  pendingCount() {
    return this.data.requests.filter((r) => r.server === this.server && r.status === 'pending').length;
  }

  // For the Players page: this server's requests, newest first, and the invites.
  view() {
    this.save(); // applies expiry
    const now = this.now();
    return {
      requests: this.data.requests.filter((r) => r.server === this.server).slice(-50).reverse(),
      invites: this.data.invites.filter((i) => i.server === this.server).map(({ hash: h, ...i }) => ({ ...i, active: inviteUsable(i, now) })).reverse(),
    };
  }

  // --- invite links --------------------------------------------------------

  createInvite({ label = '', days = 7, uses = 1, auto = false, address = '' }, by) {
    const d = Number(days);
    const u = Number(uses);
    if (!(d === 0 || (Number.isInteger(d) && d >= 1 && d <= 90))) throw bad(400, 'Valid for 1 to 90 days, or 0 for no expiry');
    if (!(Number.isInteger(u) && u >= 1 && u <= 50)) throw bad(400, 'An invite can be used 1 to 50 times');
    const addr = String(address || '').trim();
    if (addr && !/^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(addr)) throw bad(400, 'The server address is a host name or IP, optionally with :port');
    const token = crypto.randomBytes(18).toString('base64url');
    const invite = {
      id: crypto.randomBytes(6).toString('hex'),
      hash: hash(token),
      server: this.server,
      label: String(label).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60),
      created: new Date(this.now()).toISOString(),
      by,
      expires: d ? new Date(this.now() + d * DAY).toISOString() : null,
      max: u,
      used: 0,
      names: [],
      auto: Boolean(auto),
      address: addr || null,
    };
    this.data.invites.push(invite);
    this.save();
    return { token, invite: (({ hash: h, ...i }) => i)(invite) };
  }

  revokeInvite(id) {
    const i = this.data.invites.find((x) => x.id === id);
    if (!i) throw bad(404, 'No such invite');
    i.revoked = true;
    this.save();
    return { ok: true };
  }

  inviteFor(token) {
    if (!/^[A-Za-z0-9_-]{24}$/.test(String(token))) return null;
    const h = hash(token);
    const i = this.data.invites.find((x) => x.hash === h);
    return i && inviteUsable(i, this.now()) ? i : null;
  }

  // Ten tries an hour per address for the public page.
  limited(ip) {
    const now = this.now();
    const hits = (this.publicHits.get(ip) || []).filter((t) => now - t < 3600e3);
    hits.push(now);
    this.publicHits.set(ip, hits);
    if (this.publicHits.size > 2000) this.publicHits.delete(this.publicHits.keys().next().value);
    return hits.length > 10;
  }

  // The friend submitted their name on the invite page.
  async redeem(token, rawName, ip, { onlineMode = true } = {}) {
    if (this.limited(ip)) throw bad(429, 'Too many tries. Wait a while and open the link again.');
    const i = this.inviteFor(token);
    if (!i) throw bad(410, 'This invite has expired or was already used. Ask for a new link.');
    const name = String(rawName || '').trim();
    if (!NAME_RE.test(name)) throw bad(400, 'A Minecraft name is up to 16 letters, digits or underscores.');
    let uuid = null;
    let exact = name;
    if (onlineMode) {
      const found = await this.lookup(name);
      if (found === false) throw bad(404, `There's no Minecraft account called ${name}. Check the spelling (it's the name shown in the game, not your Microsoft email).`);
      if (found) ({ id: uuid, name: exact } = found);
    }
    if (i.names.some((n) => n.toLowerCase() === exact.toLowerCase())) return { name: exact, status: i.auto ? 'allowed' : 'pending', again: true };
    i.used++;
    i.names.push(exact);
    const r = this.knock({ name: exact, uuid, ip, via: 'invite', invite: i.label || i.id });
    if (i.auto && r.status === 'pending') {
      try {
        await this.allow(r.id, `invite ${i.label || i.id}`);
      } catch (err) {
        this.log(`join: invite could not whitelist ${exact}: ${err.message}`);
        this.save();
        return { name: exact, status: 'pending' };
      }
    }
    this.save();
    return { name: exact, status: r.status };
  }
}

function inviteUsable(i, now) {
  return !i.revoked && i.used < i.max && !(i.expires && Date.parse(i.expires) < now);
}

// spigot.yml "messages: whitelist: …", for servers with their own wording.
function readWhitelistMessage(mcDir) {
  if (!mcDir) return null;
  try {
    const text = fs.readFileSync(path.join(mcDir, 'spigot.yml'), 'utf8');
    const block = text.match(/^messages:\s*\n((?:[ \t]+.*\n?)*)/m);
    const m = block && block[1].match(/^\s+whitelist:\s*['"]?(.*?)['"]?\s*$/m);
    return m && m[1] ? m[1].replace(/&[0-9a-fk-or]/gi, '').trim() : null;
  } catch {
    return null;
  }
}

// { id, name } for an existing account, false for none, null when Mojang
// can't be asked (then the server checks the name when it whitelists).
async function mojangLookup(name) {
  try {
    const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(5000) });
    if (res.status === 204 || res.status === 404) return false;
    if (!res.ok) return null;
    const j = await res.json();
    if (!j?.id || !UUID_RE.test(j.id)) return null;
    const id = j.id.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    return { id, name: NAME_RE.test(j.name) ? j.name : name };
  } catch {
    return null;
  }
}

module.exports = { JoinRequests, mojangLookup, readWhitelistMessage };

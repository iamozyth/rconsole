'use strict';

// velocity.toml for the proxies rconsole installs, and the servers behind
// them. Velocity forwards each player's real UUID and address to the
// servers ("modern" forwarding, signed with forwarding.secret); the servers
// then run with online-mode=false but listen on 127.0.0.1 only, so the only
// way in is through the proxy. Plain text edits of Velocity's own default
// file, so its comments stay.

const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;

const fail = (msg) => {
  throw new Error(msg);
};

// [section] -> [start, end) line indexes of its body.
function section(lines, name) {
  const start = lines.findIndex((l) => l.trim() === `[${name}]`);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^\s*\[[^\]]+\]\s*$/.test(l));
  if (end < 0) end = lines.length;
  return [start + 1, end];
}

// Velocity's default config for a new proxy: our port, modern forwarding,
// and none of the example servers (lobby, factions, minigames).
function configure(defaults, port) {
  let toml = defaults.replace(/^bind = ".*"$/m, `bind = "0.0.0.0:${port}"`);
  if (!toml.includes(`bind = "0.0.0.0:${port}"`)) fail('Could not set the Velocity port');
  toml = forwarding(toml);
  const lines = toml.split('\n');
  for (const name of ['forced-hosts', 'servers']) {
    const s = section(lines, name);
    if (!s) fail(`velocity.toml has no [${name}] section`);
    const [a, b] = s;
    // Keep comments; drop the example entries and their multi-line values.
    const body = lines.slice(a, b).filter((l) => /^\s*(#|$)/.test(l));
    if (name === 'servers') {
      // Under the comment that explains it, as in Velocity's own file.
      const at = body.findIndex((l) => /order we should try/i.test(l));
      body.splice(at < 0 ? body.length : at + 1, 0, 'try = []');
    }
    lines.splice(a, b - a, ...body);
  }
  return lines.join('\n');
}

function forwarding(toml) {
  const out = toml.replace(/^player-info-forwarding-mode = ".*"$/m, 'player-info-forwarding-mode = "MODERN"');
  if (!/^player-info-forwarding-mode = "MODERN"$/m.test(out)) fail('Could not turn on modern forwarding in velocity.toml');
  return out;
}

const tryList = (lines, [a, b]) => {
  const i = lines.slice(a, b).findIndex((l) => /^try\s*=/.test(l));
  if (i < 0) return null;
  // try = [ ... ] may span several lines.
  let j = a + i;
  while (j < b && !lines[j].includes(']')) j++;
  return [a + i, j, (lines.slice(a + i, j + 1).join(' ').match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1))];
};

// Registers server `id` on 127.0.0.1:port; the first one becomes where
// players land. Also switches an older proxy to modern forwarding.
function addServer(toml, id, port) {
  const lines = forwarding(toml).split('\n');
  const s = section(lines, 'servers');
  if (!s) fail('velocity.toml has no [servers] section');
  const entry = new RegExp(`^"?${id}"?\\s*=`);
  for (let i = s[0]; i < s[1]; i++) if (entry.test(lines[i])) lines.splice(i, 1, `${id} = "127.0.0.1:${port}"`);
  if (!lines.slice(s[0], s[1]).some((l) => entry.test(l))) {
    // After the other servers, before the comment on the try list.
    const t = tryList(lines, s);
    const note = lines.slice(s[0], s[1]).findIndex((l) => /order we should try/i.test(l));
    let at = note >= 0 ? s[0] + note : t ? t[0] : s[1];
    while (at > s[0] && !lines[at - 1].trim()) at--;
    lines.splice(at, 0, `${id} = "127.0.0.1:${port}"`);
  }
  const s2 = section(lines, 'servers');
  const t = tryList(lines, s2);
  if (!t) lines.splice(s2[1], 0, `try = ["${id}"]`);
  else if (!t[2].length) lines.splice(t[0], t[1] - t[0] + 1, `try = ["${id}"]`);
  return lines.join('\n');
}

function removeServer(toml, id) {
  const lines = toml.split('\n');
  const s = section(lines, 'servers');
  if (!s) return toml;
  const entry = new RegExp(`^"?${id}"?\\s*=`);
  for (let i = s[1] - 1; i >= s[0]; i--) if (entry.test(lines[i])) lines.splice(i, 1);
  const s2 = section(lines, 'servers');
  const t = tryList(lines, s2);
  if (t && t[2].includes(id)) {
    let rest = t[2].filter((n) => n !== id);
    // Players need somewhere to land: the first server that is left.
    if (!rest.length) {
      const first = lines.slice(s2[0], s2[1]).find((l) => /^"?[a-z0-9-]+"?\s*=\s*"/.test(l) && !/^try\s*=/.test(l));
      if (first) rest = [first.match(/^"?([a-z0-9-]+)/)[1]];
    }
    lines.splice(t[0], t[1] - t[0] + 1, `try = [${rest.map((n) => `"${n}"`).join(', ')}]`);
  }
  return lines.join('\n');
}

// Paper's side: config/paper-global.yml before the server's first start.
// Paper fills in everything else and keeps these values.
function paperGlobal(secret) {
  if (!SECRET_RE.test(secret)) fail('The proxy has no usable forwarding.secret');
  return `# Written by rconsole: players come through the Velocity proxy.\nproxies:\n  velocity:\n    enabled: true\n    online-mode: true\n    secret: '${secret}'\n`;
}

module.exports = { configure, addServer, removeServer, paperGlobal, SECRET_RE };

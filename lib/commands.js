'use strict';

// Discovers the server's commands for autocomplete: `minecraft:help` gives the
// Brigadier usage of every command ("/gamemode <gamemode> [<target>]"), and
// Bukkit's `help` gives descriptions, including plugin commands. Cached; the
// command set only changes when plugins or data packs change.

const CACHE_MS = 10 * 60 * 1000;
const MAX_PAGES = 30;

const strip = (s) => String(s).replace(/§[0-9a-fk-orx]/gi, '');

// "/gamemode <gamemode> [<target>]" lines, several per command possible.
function parseUsage(out) {
  const usage = new Map();
  for (const raw of strip(out).split('\n')) {
    const m = raw.trim().match(/^\/([a-z0-9_:.-]+)(?:\s+(.*))?$/i);
    if (!m) continue;
    const name = m[1].toLowerCase();
    if (!usage.has(name)) usage.set(name, []);
    if (m[2] && usage.get(name).length < 8) usage.get(name).push(m[2].slice(0, 300));
  }
  return usage;
}

// Bukkit help index: "/name: description" lines, and "(1/12)" in the header.
function parseHelp(out) {
  const desc = new Map();
  let pages = 1;
  for (const raw of strip(out).split('\n')) {
    const line = raw.trim();
    const p = line.match(/\((\d+)\/(\d+)\)/);
    if (p && /help/i.test(line)) pages = Number(p[2]);
    const m = line.match(/^\/([a-z0-9_:.-]+):\s*(.*)$/i);
    if (m && !desc.has(m[1].toLowerCase())) desc.set(m[1].toLowerCase(), m[2].slice(0, 200));
  }
  return { desc, pages };
}

class CommandCatalog {
  constructor({ rcon, log = () => {} }) {
    this.rcon = rcon;
    this.log = log;
    this.cache = null;
    this.at = 0;
  }

  async discover() {
    const usage = parseUsage(await this.rcon.send('minecraft:help').catch(() => ''));
    const first = await this.rcon.send('help').catch(() => '');
    const { desc, pages } = parseHelp(first);
    for (let i = 2; i <= Math.min(pages, MAX_PAGES); i++) {
      for (const [k, v] of parseHelp(await this.rcon.send(`help ${i}`).catch(() => '')).desc) if (!desc.has(k)) desc.set(k, v);
    }
    const names = new Set([...usage.keys(), ...desc.keys()].filter((n) => !n.includes(':')));
    return [...names].sort().map((name) => ({ name, usage: usage.get(name) || [], description: desc.get(name) || null }));
  }

  async list({ refresh = false } = {}) {
    if (!refresh && this.cache && Date.now() - this.at < CACHE_MS) return this.cache;
    try {
      const commands = await this.discover();
      // An offline server answers nothing; keep the last good list then.
      if (commands.length || !this.cache) this.cache = { commands, at: new Date().toISOString(), error: commands.length ? null : 'The server returned no commands' };
      this.at = Date.now();
    } catch (err) {
      this.cache = { ...(this.cache || { commands: [] }), error: err.message };
    }
    return this.cache;
  }
}

module.exports = { CommandCatalog, parseUsage, parseHelp };

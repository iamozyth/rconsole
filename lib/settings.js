'use strict';

// Typed allowlist of server.properties keys rconsole may change. The helper
// re-validates every write against this list, so a compromised rconsole still
// can't touch RCON, ports or anything else that would lock the admin out.

const bool = { type: 'bool' };
const int = (min, max) => ({ type: 'int', min, max });
const choice = (...values) => ({ type: 'enum', values });

// `default`: the vanilla value used when the key is missing from the file.
// `live`: RCON command that applies the value without a restart.
const EDITABLE = [
  { key: 'motd', default: 'A Minecraft Server', group: 'General', label: 'Message of the day', type: 'string', max: 120 },
  { key: 'max-players', default: '20', group: 'General', label: 'Max players', ...int(1, 1000) },
  { key: 'white-list', default: 'false', group: 'General', label: 'Whitelist', ...bool, live: (v) => `whitelist ${v === 'true' ? 'on' : 'off'}` },
  { key: 'enforce-whitelist', default: 'false', group: 'General', label: 'Kick players removed from the whitelist', ...bool },
  { key: 'online-mode', default: 'true', group: 'General', label: 'Online mode (verify accounts with Mojang)', ...bool, warning: 'Turning this off lets anyone join under any name.' },
  { key: 'player-idle-timeout', default: '0', group: 'General', label: 'Idle kick (minutes, 0 = never)', ...int(0, 1440) },
  { key: 'hide-online-players', default: 'false', group: 'General', label: 'Hide player list in the server browser', ...bool },

  { key: 'difficulty', default: 'easy', group: 'Gameplay', label: 'Difficulty', ...choice('peaceful', 'easy', 'normal', 'hard'), live: (v) => `difficulty ${v}` },
  { key: 'gamemode', default: 'survival', group: 'Gameplay', label: 'Default game mode', ...choice('survival', 'creative', 'adventure', 'spectator'), live: (v) => `defaultgamemode ${v}` },
  { key: 'force-gamemode', default: 'false', group: 'Gameplay', label: 'Force default game mode on join', ...bool },
  { key: 'hardcore', default: 'false', group: 'Gameplay', label: 'Hardcore', ...bool },
  { key: 'pvp', default: 'true', group: 'Gameplay', label: 'PvP', ...bool },
  { key: 'allow-flight', default: 'false', group: 'Gameplay', label: 'Allow flight (don’t kick for flying)', ...bool },
  { key: 'spawn-protection', default: '16', group: 'Gameplay', label: 'Spawn protection radius', ...int(0, 64) },
  { key: 'enable-command-block', default: 'false', group: 'Gameplay', label: 'Command blocks', ...bool },

  { key: 'allow-nether', default: 'true', group: 'World', label: 'Allow the Nether', ...bool },
  { key: 'generate-structures', default: 'true', group: 'World', label: 'Generate structures (new chunks)', ...bool },
  { key: 'max-world-size', default: '29999984', group: 'World', label: 'World border radius (blocks)', ...int(1, 29999984) },

  { key: 'view-distance', default: '10', group: 'Performance', label: 'View distance (chunks)', ...int(2, 32) },
  { key: 'simulation-distance', default: '10', group: 'Performance', label: 'Simulation distance (chunks)', ...int(2, 32) },
  { key: 'entity-broadcast-range-percentage', default: '100', group: 'Performance', label: 'Entity render range (%)', ...int(10, 1000) },
  { key: 'sync-chunk-writes', default: 'true', group: 'Performance', label: 'Synchronous chunk writes', ...bool },
];

// Written only by world operations, never from the settings form.
const WORLD_KEYS = [
  { key: 'level-name', type: 'world' },
  { key: 'level-seed', type: 'string', max: 64 },
  { key: 'level-type', ...choice('minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified') },
];

// Never shown in clear text.
const SECRET_KEYS = new Set(['rcon.password', 'management-server-secret']);

const BY_KEY = new Map([...EDITABLE, ...WORLD_KEYS].map((s) => [s.key, s]));

// Returns the canonical string for a value, or throws with a readable reason.
function normalize(key, value, { allowWorldKeys = false } = {}) {
  const spec = BY_KEY.get(key);
  if (!spec || (!allowWorldKeys && WORLD_KEYS.some((w) => w.key === key))) throw new Error(`${key} can't be changed from rconsole`);
  const s = String(value);
  if (/[\r\n\0]/.test(s)) throw new Error(`${key}: line breaks aren't allowed`);
  switch (spec.type) {
    case 'bool':
      if (s !== 'true' && s !== 'false') throw new Error(`${key} must be true or false`);
      return s;
    case 'int': {
      if (!/^-?\d+$/.test(s)) throw new Error(`${key} must be a whole number`);
      const n = Number(s);
      if (n < spec.min || n > spec.max) throw new Error(`${key} must be between ${spec.min} and ${spec.max}`);
      return String(n);
    }
    case 'enum':
      if (!spec.values.includes(s)) throw new Error(`${key} must be one of ${spec.values.join(', ')}`);
      return s;
    case 'world':
      if (!require('./names').isWorldName(s)) throw new Error('World names use letters, digits, - and _ (max 32)');
      return s;
    default:
      if (s.length > spec.max) throw new Error(`${key} is limited to ${spec.max} characters`);
      return s;
  }
}

function normalizeAll(updates, opts) {
  const out = {};
  for (const [k, v] of Object.entries(updates || {})) out[k] = normalize(k, v, opts);
  if (!Object.keys(out).length) throw new Error('Nothing to change');
  return out;
}

module.exports = { EDITABLE, WORLD_KEYS, SECRET_KEYS, normalize, normalizeAll };

'use strict';

// Game rules (keep inventory, mob griefing, sleeping percentage, …), read
// and changed over RCON while the server runs. Which rules exist comes from
// the server itself (`minecraft:help gamerule`), so rules added by a newer
// version, a mod or a datapack show up too; the catalog below only adds
// words and groups. Minecraft 26 renamed the rules to snake_case
// (keepInventory → keep_inventory); older servers keep the old names, which
// map onto the same entries. Paper keeps game rules per world, vanilla
// shares one set, so values are read in each dimension and a change can go
// to all of them.

const bad = (status, msg) => Object.assign(new Error(msg), { status });

const DIMENSIONS = [
  { id: 'minecraft:overworld', label: 'Overworld' },
  { id: 'minecraft:the_nether', label: 'Nether' },
  { id: 'minecraft:the_end', label: 'End' },
];
const GROUPS = ['Players', 'Mobs', 'World', 'Chat and messages', 'Commands and admins', 'Advanced'];

// name: [group, label, description, common?]
const CATALOG = {
  keep_inventory: ['Players', 'Keep inventory', 'Players keep their items and experience when they die.', true],
  pvp: ['Players', 'Player vs. player', 'Players can hurt each other.', true],
  players_sleeping_percentage: ['Players', 'Players needed to skip the night', 'Percent of online players that must sleep to skip the night. 0 lets one player do it.', true],
  immediate_respawn: ['Players', 'Respawn right away', 'Skip the death screen.', true],
  natural_health_regeneration: ['Players', 'Health regenerates', 'Players heal over time when their hunger bar is full enough.', true],
  respawn_radius: ['Players', 'Spawn radius', 'How far from the world spawn players without a bed appear, in blocks.', true],
  locator_bar: ['Players', 'Locator bar', 'Shows where other players are in the experience bar.', true],
  fall_damage: ['Players', 'Fall damage', 'Players take damage when they fall.'],
  fire_damage: ['Players', 'Fire damage', 'Players take damage from fire and lava.'],
  drowning_damage: ['Players', 'Drowning damage', 'Players take damage when they run out of air.'],
  freeze_damage: ['Players', 'Freeze damage', 'Players take damage in powder snow.'],
  ender_pearls_vanish_on_death: ['Players', 'Ender pearls vanish on death', 'Thrown ender pearls disappear when their thrower dies.'],
  spectators_generate_chunks: ['Players', 'Spectators load new terrain', 'Players in spectator mode generate chunks as they fly.'],
  players_nether_portal_default_delay: ['Players', 'Nether portal delay', 'Ticks a player stands in a nether portal before travelling (20 ticks = 1 second).'],
  players_nether_portal_creative_delay: ['Players', 'Nether portal delay in creative', 'The same, for players in creative mode.'],
  allow_entering_nether_using_portals: ['Players', 'Nether portals work', 'Players can travel to the Nether through portals.'],

  mob_griefing: ['Mobs', 'Mob griefing', 'Creepers blow up blocks, endermen pick them up, villagers farm. Off also stops some mob farms.', true],
  spawn_phantoms: ['Mobs', 'Phantoms', 'Phantoms come for players who haven\'t slept for three days.', true],
  spawn_mobs: ['Mobs', 'Mobs spawn', 'Animals and monsters spawn naturally.'],
  spawn_monsters: ['Mobs', 'Monsters spawn', 'Hostile mobs spawn naturally.'],
  spawn_patrols: ['Mobs', 'Pillager patrols', 'Pillager patrols spawn.'],
  spawn_wandering_traders: ['Mobs', 'Wandering traders', 'Wandering traders visit.'],
  spawn_wardens: ['Mobs', 'Wardens', 'Wardens can emerge from sculk shriekers.'],
  raids: ['Mobs', 'Raids', 'A player with Bad Omen starts a raid in a village.'],
  mob_drops: ['Mobs', 'Mob loot', 'Mobs drop items when killed.'],
  entity_drops: ['Mobs', 'Entity drops', 'Minecarts, boats, item frames and the like drop themselves when broken.'],
  universal_anger: ['Mobs', 'Universal anger', 'Angered neutral mobs attack every player nearby, not only the one who angered them.'],
  forgive_dead_players: ['Mobs', 'Forgive dead players', 'Angered neutral mobs calm down when the player they target dies.'],
  max_entity_cramming: ['Mobs', 'Entity cramming limit', 'Mobs crammed into one block start taking damage above this number. 0 turns it off.'],
  spawner_blocks_work: ['Mobs', 'Spawners work', 'Monster spawners spawn mobs.'],

  advance_time: ['World', 'Day and night cycle', 'Time moves on. Off freezes the time of day.', true],
  advance_weather: ['World', 'Weather changes', 'Rain and thunder come and go. Off keeps the current weather.', true],
  fire_spread_radius_around_player: ['World', 'Fire spreads near players', 'Fire spreads and burns out within this many blocks of a player. 0 stops fire from spreading.', true],
  random_tick_speed: ['World', 'Random tick speed', 'How fast crops and trees grow, leaves decay and fire burns. 3 is normal; high values cost performance.'],
  block_drops: ['World', 'Blocks drop items', 'Broken blocks drop themselves.'],
  tnt_explodes: ['World', 'TNT explodes', 'Lit TNT explodes.'],
  block_explosion_drop_decay: ['World', 'Block explosions lose drops', 'Blocks destroyed by beds and respawn anchors exploding only sometimes drop.'],
  mob_explosion_drop_decay: ['World', 'Mob explosions lose drops', 'Blocks destroyed by creepers and other mobs only sometimes drop.'],
  tnt_explosion_drop_decay: ['World', 'TNT explosions lose drops', 'Blocks destroyed by TNT only sometimes drop.'],
  projectiles_can_break_blocks: ['World', 'Projectiles break blocks', 'Projectiles break blocks they can break, such as decorated pots.'],
  spread_vines: ['World', 'Vines spread', 'Vines grow onto nearby blocks.'],
  water_source_conversion: ['World', 'Infinite water', 'Two water sources make a new one.'],
  lava_source_conversion: ['World', 'Infinite lava', 'Two lava sources make a new one.'],
  max_snow_accumulation_height: ['World', 'Snow height', 'How many layers of snow pile up during snowfall.'],
  global_sound_events: ['World', 'Global boss sounds', 'Everyone hears certain events, such as a wither spawning or the ender dragon dying.'],

  show_death_messages: ['Chat and messages', 'Death messages', 'Deaths are announced in chat.', true],
  show_advancement_messages: ['Chat and messages', 'Advancement messages', 'Advancements are announced in chat.'],
  command_block_output: ['Chat and messages', 'Command block output', 'Operators see in chat what command blocks do.'],
  send_command_feedback: ['Chat and messages', 'Command feedback', 'Players see the answer to their commands.'],
  log_admin_commands: ['Chat and messages', 'Admin commands in the log', 'Commands operators run are shown to other operators and logged.'],
  reduced_debug_info: ['Chat and messages', 'Reduced debug screen', 'The F3 screen hides coordinates and other details.'],

  command_blocks_work: ['Commands and admins', 'Command blocks work', 'Command blocks run their commands.'],
  limited_crafting: ['Commands and admins', 'Limited crafting', 'Players can only craft recipes they have unlocked.'],
  player_movement_check: ['Commands and admins', 'Movement check', 'The server rejects players that move too fast (anti-cheat for speed).'],
  elytra_movement_check: ['Commands and admins', 'Elytra movement check', 'The same for players flying with elytra.'],

  max_command_forks: ['Advanced', 'Command fork limit', 'Most contexts one command may create, for example through execute as @e.'],
  max_command_sequence_length: ['Advanced', 'Command chain limit', 'Most commands one function or command block chain may run.'],
  max_block_modifications: ['Advanced', 'Block change limit', 'Most blocks one command such as fill or clone may change.'],
};

// Names before Minecraft 26 where the new name isn't just snake_case.
const OLD = {
  doDaylightCycle: 'advance_time', doWeatherCycle: 'advance_weather', doMobSpawning: 'spawn_mobs', doInsomnia: 'spawn_phantoms',
  doTileDrops: 'block_drops', doEntityDrops: 'entity_drops', doMobLoot: 'mob_drops', doPatrolSpawning: 'spawn_patrols',
  doTraderSpawning: 'spawn_wandering_traders', doWardenSpawning: 'spawn_wardens', doImmediateRespawn: 'immediate_respawn',
  doLimitedCrafting: 'limited_crafting', doVinesSpread: 'spread_vines', naturalRegeneration: 'natural_health_regeneration',
  announceAdvancements: 'show_advancement_messages', spawnRadius: 'respawn_radius', snowAccumulationHeight: 'max_snow_accumulation_height',
  maxCommandChainLength: 'max_command_sequence_length', commandModificationBlockLimit: 'max_block_modifications', maxCommandForkCount: 'max_command_forks',
};
const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const catalogKey = (name) => {
  const bare = name.replace(/^minecraft:/, '');
  return OLD[bare] || (CATALOG[snake(bare)] ? snake(bare) : bare);
};

// "Game rule keep_inventory is currently set to false" (26), "Gamerule
// keepInventory is currently set to: false" (before). Setting a rule to the
// value it has answers "… is already set to …".
const VALUE = /(?:Game ?rule) (\S+) is (?:currently|now|already) set to:? (\S+)/i;
const NAME_RE = /^[A-Za-z0-9_:.-]{1,80}$/;

function parseRuleNames(help) {
  const names = new Set();
  for (const m of String(help).matchAll(/\/?gamerule[ \t]+([A-Za-z][A-Za-z0-9_:.-]*)/g)) {
    const n = m[1];
    if (n.startsWith('minecraft:') && names.has(n.slice(10))) continue;
    if (!n.startsWith('minecraft:') && names.has(`minecraft:${n}`)) names.delete(`minecraft:${n}`);
    names.add(n);
  }
  return [...names];
}

class GameRules {
  constructor({ rcon, log = () => {}, now = () => Date.now() }) {
    Object.assign(this, { rcon, log, now });
    this.names = null; // { at, list }
  }

  async send(cmd) {
    return String(await this.rcon.send(cmd)).replace(/§./g, '');
  }

  async ruleNames() {
    if (this.names && this.now() - this.names.at < 10 * 60 * 1000) return this.names.list;
    let list = parseRuleNames(await this.send('minecraft:help gamerule'));
    if (!list.length) list = parseRuleNames(await this.send('help gamerule'));
    if (!list.length) throw bad(502, 'The server did not list its game rules.');
    this.names = { at: this.now(), list };
    return list;
  }

  // In one dimension; null if the dimension doesn't exist.
  async read(name, dim) {
    const out = await this.send(dim === DIMENSIONS[0].id ? `gamerule ${name}` : `execute in ${dim} run gamerule ${name}`);
    const m = VALUE.exec(out);
    return m ? m[2] : null;
  }

  async view() {
    const names = await this.ruleNames();
    const worlds = [];
    for (const d of DIMENSIONS) if ((await this.read(names[0], d.id)) !== null) worlds.push(d);
    if (!worlds.length) throw bad(502, 'Could not read the game rules.');
    const rules = [];
    for (const name of names) {
      const values = {};
      for (const w of worlds) values[w.id] = await this.read(name, w.id);
      const value = values[worlds[0].id];
      if (value === null) continue;
      const key = catalogKey(name);
      const [group, label, description, common] = CATALOG[key] || ['Advanced', name.replace(/^minecraft:/, ''), null, false];
      const type = /^(true|false)$/.test(value) ? 'bool' : /^-?\d+$/.test(value) ? 'int' : 'string';
      const others = worlds.slice(1).filter((w) => values[w.id] !== null && values[w.id] !== value).map((w) => ({ world: w.label, value: values[w.id] }));
      rules.push({ name, key, group, label, description, common: Boolean(common), known: Boolean(CATALOG[key]), type, value, differs: others });
    }
    rules.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.label.localeCompare(b.label));
    return { worlds: worlds.map((w) => w.label), groups: GROUPS, rules };
  }

  // changes: [{ name, value }]; all: every dimension, or the overworld only.
  async set(changes, { all = true } = {}) {
    if (!Array.isArray(changes) || !changes.length || changes.length > 80) throw bad(400, 'Nothing to change');
    const names = new Set(await this.ruleNames());
    for (const c of changes) {
      if (!NAME_RE.test(String(c?.name)) || !names.has(c.name)) throw bad(400, `Unknown game rule: ${String(c?.name).slice(0, 80)}`);
      const v = String(c.value);
      if (!/^(true|false|-?\d{1,10})$/.test(v)) throw bad(400, `${c.name}: true, false or a whole number`);
    }
    const dims = all ? DIMENSIONS : DIMENSIONS.slice(0, 1);
    const done = [];
    for (const c of changes) {
      const v = String(c.value);
      for (const d of dims) {
        const out = await this.send(d === DIMENSIONS[0] ? `gamerule ${c.name} ${v}` : `execute in ${d.id} run gamerule ${c.name} ${v}`);
        if (VALUE.test(out)) continue;
        // A dimension that doesn't exist (no Nether on this server) is no error.
        if (d !== DIMENSIONS[0] && /dimension/i.test(out)) continue;
        throw bad(400, `${c.name}: ${out.split('\n')[0].slice(0, 200) || 'the server did not accept it'}`);
      }
      done.push(`${c.name} = ${v}`);
    }
    this.log(`gamerules: ${done.join(', ')}${all ? '' : ' (overworld)'}`);
    return { changed: done.length };
  }
}

module.exports = { GameRules, parseRuleNames, catalogKey, CATALOG, VALUE };

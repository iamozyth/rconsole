'use strict';

// Lag detective: when the server lags (or on request), look at what usually
// causes it and say so in plain words. One investigation asks the server a
// handful of things over RCON (tick times, loaded chunks, entities by type
// and where they pile up, where the players are and how fast they move),
// reads memory and CPU, and turns that into findings with the evidence and
// what to do. Reports are kept in STATE_DIR/lag.json (the last 20).

const fs = require('fs');
const path = require('path');

const KEEP = 20;
const AUTO_GAP_MS = 15 * 60 * 1000;
const MAX_PLAYERS = 30;
const SECOND_LOOK_MS = 4000;
// Ticking entities of one type that are worth a look, and a lot.
const LIMITS = {
  'minecraft:item': [300, 1500],
  'minecraft:experience_orb': [150, 600],
  'minecraft:arrow': [300, 1000],
  'minecraft:falling_block': [100, 400],
  'minecraft:tnt': [30, 200],
  'minecraft:minecart': [100, 400],
  'minecraft:hopper_minecart': [50, 200],
  'minecraft:villager': [80, 250],
};
const MOB_LIMITS = [250, 800];
const TOTAL_LIMITS = [1500, 4000];
const HOTSPOT_MIN = 60;
const DIMENSION_NAMES = { 'minecraft:overworld': 'overworld', 'minecraft:the_nether': 'Nether', 'minecraft:the_end': 'End' };
const VANILLA_TYPES = ['minecraft:item', 'minecraft:experience_orb', 'minecraft:villager', 'minecraft:arrow', 'minecraft:falling_block', 'minecraft:tnt'];

const label = (type) => type.replace(/^minecraft:/, '').replace(/_/g, ' ');
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : /(s|sh|ch|x)$/.test(word) ? 'es' : 's'}`;
const unknown = (reply) => /unknown or incomplete command|unknown command|incorrect argument/i.test(reply || '');

// "◴ 1.3/0.8/4.0, 1.2/0.8/4.0, 2.3/0.7/262.3" (Paper's mspt: 5 s, 10 s, 1 min)
function parseMspt(out) {
  const m = String(out).match(/([\d.]+)\/([\d.]+)\/([\d.]+),\s*([\d.]+)\/([\d.]+)\/([\d.]+),\s*([\d.]+)\/([\d.]+)\/([\d.]+)/);
  return m ? { avg: Number(m[1]), max: Number(m[9]), avg1m: Number(m[7]) } : null;
}

// `tick query`: average and percentiles of the last 100 ticks.
function parseTickQuery(out) {
  const avg = String(out).match(/Average time per tick:\s*([\d.]+)\s*ms/i);
  if (!avg) return null;
  const p = (k) => Number((String(out).match(new RegExp(`${k}:\\s*([\\d.]+)ms`, 'i')) || [])[1]) || null;
  return { avg: Number(avg[1]), p95: p('P95'), p99: p('P99') };
}

// `paper chunkinfo`: per world Total / Inactive / Full / Block Ticking / Entity Ticking.
function parseChunkInfo(out) {
  const worlds = [];
  const re = /Chunks in (\S+?):\s*Total: (\d+) Inactive: (\d+) Full: (\d+) Block Ticking: (\d+) Entity Ticking: (\d+)/g;
  let m;
  while ((m = re.exec(String(out)))) {
    if (m[1] === 'all') continue;
    worlds.push({ key: m[1], total: Number(m[2]), full: Number(m[4]), blockTicking: Number(m[5]), entityTicking: Number(m[6]) });
  }
  return worlds;
}

// `paper entity list * <world>`: "  6 (16) : minecraft:zombie" (ticking, non-ticking).
function parseEntityList(out) {
  const total = String(out).match(/Total Ticking: (\d+), Total Non-Ticking: (\d+)/);
  const types = [];
  for (const m of String(out).matchAll(/^\s*(\d+) \((\d+)\) : (\S+)$/gm)) types.push({ type: m[3], ticking: Number(m[1]), idle: Number(m[2]) });
  return total ? { ticking: Number(total[1]), idle: Number(total[2]), types: types.sort((a, b) => b.ticking - a.ticking || b.idle - a.idle) } : null;
}

// `paper entity list <type> <world>`: "  3: 0, 0 (Ticking)" (count: chunk x, z).
function parseEntityChunks(out) {
  const out2 = [];
  for (const m of String(out).matchAll(/^\s*(\d+): (-?\d+), (-?\d+) \((Ticking|Non-Ticking)\)$/gm)) out2.push({ count: Number(m[1]), cx: Number(m[2]), cz: Number(m[3]), ticking: m[4] === 'Ticking' });
  return out2.sort((a, b) => b.count - a.count);
}

const parseCount = (out) => {
  const m = String(out).match(/Count: (\d+)/i);
  return m ? Number(m[1]) : /test failed/i.test(out) ? 0 : null;
};
const parsePos = (out) => {
  const m = String(out).match(/\[(-?[\d.E-]+)d, (-?[\d.E-]+)d, (-?[\d.E-]+)d\]/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const parseDim = (out) => (String(out).match(/"([a-z0-9_.-]+:[a-z0-9_./-]+)"/) || [])[1] || null;

// CPU time this machine spent waiting for its VM host ("steal"), over `ms`.
function readStat() {
  try {
    const f = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    return { total: f.reduce((a, b) => a + b, 0), steal: f[7] || 0 };
  } catch {
    return null;
  }
}

class LagDetective {
  constructor({ rcon, stats, power, stateDir, mcDir, log = () => {}, now = () => Date.now() }) {
    Object.assign(this, { rcon, stats, power, mcDir, log, now });
    this.file = path.join(stateDir, 'lag.json');
    this.reports = [];
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(d.reports)) this.reports = d.reports.slice(0, KEEP);
    } catch {}
    this.running = null;
    this.lastAuto = -Infinity;
    this.slow = 0;
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ reports: this.reports }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  view() {
    return { running: Boolean(this.running), reports: this.reports.map(({ id, at, reason, by, headline, severity, tps }) => ({ id, at, reason, by, headline, severity, tps })) };
  }

  report(id) {
    const r = this.reports.find((x) => x.id === id);
    if (!r) throw Object.assign(new Error('No such report'), { status: 404 });
    return r;
  }

  // Every metrics sample: two slow samples in a row start an investigation
  // (at most every 15 minutes), so the report shows the lag as it happens.
  onSample(sample, threshold = 15) {
    const slow = sample.up === 1 && ((sample.tps != null && sample.tps < threshold) || (sample.mspt != null && sample.mspt > 50));
    this.slow = slow ? this.slow + 1 : 0;
    if (this.slow >= 2 && !this.running && this.now() - this.lastAuto > AUTO_GAP_MS) {
      this.lastAuto = this.now();
      this.investigate({ reason: 'auto' }).catch((err) => this.log(`lag: ${err.message}`));
    }
  }

  investigate({ reason = 'manual', by = null } = {}) {
    if (this.running) return this.running;
    this.running = this.run({ reason, by }).finally(() => (this.running = null));
    return this.running;
  }

  async send(cmd) {
    try {
      const out = await this.rcon.send(cmd);
      return out == null ? null : String(out).replace(/§./g, '');
    } catch {
      return null;
    }
  }

  async run({ reason, by }) {
    const started = this.now();
    const stat0 = readStat();
    await this.power.processStats?.().catch(() => null); // CPU is measured from here
    this.stats.invalidate?.('players'); // who is online now, not half a minute ago
    const status = await this.stats.get().catch(() => null);
    if (!status?.rcon?.ok) throw Object.assign(new Error('The server is not running (or RCON is offline)'), { status: 409 });
    const r = { id: `${started.toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: new Date(started).toISOString(), reason, by, tps: status.game?.tps ?? null };

    // Tick times: Paper's mspt has the worst tick of the last minute; tick query has percentiles.
    const [msptOut, tickOut] = [await this.send('mspt'), await this.send('tick query')];
    r.mspt = { ...(unknown(msptOut) ? {} : parseMspt(msptOut) || {}), ...(parseTickQuery(tickOut) || {}) };

    // Players: where they are, twice, to see who travels fast (new chunks).
    const names = (status.game?.players?.players || []).slice(0, MAX_PLAYERS);
    const where = async () => {
      const out = {};
      for (const n of names) {
        const pos = parsePos(await this.send(`data get entity ${n} Pos`));
        if (pos) out[n] = { pos, dim: parseDim(await this.send(`data get entity ${n} Dimension`)) };
      }
      return out;
    };
    const t0 = this.now();
    const first = await where();

    // Chunks and entities (Paper); counts by type elsewhere.
    const chunkOut = await this.send('paper chunkinfo *');
    const paper = chunkOut != null && !unknown(chunkOut);
    r.paper = paper;
    r.worlds = paper ? parseChunkInfo(chunkOut) : [];
    r.hotspots = [];
    if (paper) {
      for (const w of r.worlds) {
        if (!w.total) continue;
        w.entities = parseEntityList(await this.send(`paper entity list * ${w.key}`));
        for (const t of (w.entities?.types || []).filter((x) => x.ticking >= HOTSPOT_MIN).slice(0, 3)) {
          // Ticking chunks only: what lies in a loaded but idle chunk costs little.
          const spots = parseEntityChunks(await this.send(`paper entity list ${t.type} ${w.key}`)).filter((s) => s.ticking && s.count >= HOTSPOT_MIN / 2).slice(0, 3);
          for (const s of spots) r.hotspots.push({ type: t.type, world: w.key, ...s });
        }
      }
    } else {
      const counts = [];
      for (const type of VANILLA_TYPES) {
        const n = parseCount(await this.send(`execute if entity @e[type=${type}]`));
        if (n) counts.push({ type, ticking: n, idle: 0 });
      }
      const all = parseCount(await this.send('execute if entity @e'));
      r.worlds = [{ key: 'all', entities: { ticking: all ?? counts.reduce((a, b) => a + b.ticking, 0), idle: 0, types: counts.sort((a, b) => b.ticking - a.ticking) } }];
    }

    // The second look: who moved how far, and how many chunks were added.
    const wait = SECOND_LOOK_MS - (this.now() - t0);
    if (wait > 0 && names.length) await new Promise((res) => setTimeout(res, wait));
    const second = names.length ? await where() : {};
    const secs = Math.max(1, (this.now() - t0) / 1000);
    r.players = names.filter((n) => first[n] || second[n]).map((n) => {
      const a = first[n];
      const b = second[n] || a;
      const speed = a && b && a.dim === b.dim ? Math.hypot(b.pos[0] - a.pos[0], b.pos[2] - a.pos[2]) / secs : null;
      return { name: n, dim: b.dim, pos: b.pos.map((v) => Math.round(v)), speed: speed == null ? null : Math.round(speed * 10) / 10 };
    });
    if (paper) {
      const again = parseChunkInfo(await this.send('paper chunkinfo *'));
      for (const w of r.worlds) w.added = Math.max(0, (again.find((x) => x.key === w.key)?.total ?? w.total) - w.total);
    }
    for (const h of r.hotspots) h.near = this.nearest(r.players, h);

    // Memory and CPU.
    r.heap = status.heap?.used != null && status.heap.max ? { used: status.heap.used, max: status.heap.max } : null;
    const proc = await this.power.processStats?.().catch(() => null);
    r.rss = proc?.rss ?? null;
    const stat1 = readStat();
    const cores = status.host?.cores || 1;
    r.cpu = {
      host: status.host?.cpu ?? null,
      process: proc?.cpu ?? null, // in cores
      cores,
      steal: stat0 && stat1 && stat1.total > stat0.total ? (stat1.steal - stat0.steal) / (stat1.total - stat0.total) : null,
    };
    r.settings = this.settings();

    r.findings = diagnose(r);
    r.severity = r.findings[0]?.severity || 'ok';
    r.headline = r.findings[0]?.title || 'Nothing stands out';
    r.took = this.now() - started;
    this.reports.unshift(r);
    this.reports = this.reports.slice(0, KEEP);
    this.save();
    this.log(`lag: ${reason} investigation: ${r.headline} (${Math.round(r.took / 100) / 10} s)`);
    return r;
  }

  nearest(players, h) {
    const x = h.cx * 16 + 8;
    const z = h.cz * 16 + 8;
    let best = null;
    for (const p of players) {
      if (p.dim !== h.world) continue;
      const d = Math.hypot(p.pos[0] - x, p.pos[2] - z);
      if (!best || d < best.distance) best = { name: p.name, distance: Math.round(d) };
    }
    return best;
  }

  settings() {
    try {
      const text = fs.readFileSync(path.join(this.mcDir, 'server.properties'), 'utf8');
      const get = (k) => Number((text.match(new RegExp(`^${k}=(\\d+)`, 'm')) || [])[1]) || null;
      return { viewDistance: get('view-distance'), simulationDistance: get('simulation-distance') };
    } catch {
      return {};
    }
  }
}

// The evidence, turned into findings: most severe first.
function diagnose(r) {
  const f = [];
  const add = (severity, kind, title, detail, extra = {}) => f.push({ severity, kind, title, detail, ...extra });
  const where = (h) => `chunk ${h.cx}, ${h.cz} (around ${h.cx * 16 + 8} ${h.cz * 16 + 8}${h.world && h.world !== 'minecraft:overworld' ? ` in the ${DIMENSION_NAMES[h.world] || h.world}` : ''})${h.near ? `, ${h.near.distance < 48 ? `where ${h.near.name} is` : `${h.near.distance} blocks from ${h.near.name}`}` : ''}`;

  // Entities: one type piling up, or just too many overall.
  for (const w of r.worlds || []) {
    const ents = w.entities;
    if (!ents) continue;
    for (const t of ents.types) {
      const [warn, bad] = LIMITS[t.type] || MOB_LIMITS;
      if (t.ticking < warn) continue;
      const spot = r.hotspots.find((h) => h.type === t.type && h.world === w.key);
      const clear = t.type === 'minecraft:item' || t.type === 'minecraft:experience_orb' || t.type === 'minecraft:arrow';
      add(t.ticking >= bad ? 'critical' : 'warning', 'entities', `${plural(t.ticking, label(t.type))}${w.key !== 'all' && w.key !== 'minecraft:overworld' ? ` in the ${DIMENSION_NAMES[w.key] || w.key}` : ''}`,
        `${spot ? `Most of them in ${where(spot)}: ${spot.count.toLocaleString('en-US')} in one chunk. ` : ''}${clear ? 'Dropped items, orbs and arrows on the ground are moved and merged every tick; a broken farm or a mob grinder often leaves thousands.' : 'Every mob is moved, pathfinds and checks its surroundings every tick; a farm that breeds without a limit adds up fast.'}`,
        { action: clear ? { label: `Remove ${label(t.type)}s`, command: `kill @e[type=${t.type}]` } : null, spot: spot || null });
    }
    if (ents.ticking >= TOTAL_LIMITS[0] && !f.some((x) => x.kind === 'entities')) {
      add(ents.ticking >= TOTAL_LIMITS[1] ? 'critical' : 'warning', 'entities', `${plural(ents.ticking, 'ticking entity')}`, 'Many mobs and items in loaded chunks, spread over several types. Look at the list below for the biggest groups.');
    }
  }

  // Players who travel fast make the server load and generate chunks.
  const added = (r.worlds || []).reduce((a, w) => a + (w.added || 0), 0);
  const fast = (r.players || []).filter((p) => p.speed != null && p.speed >= 20).sort((a, b) => b.speed - a.speed);
  if (fast.length || added >= 40) {
    add(added >= 120 || fast.some((p) => p.speed >= 40) ? 'critical' : 'warning', 'chunks',
      fast.length ? `${fast.map((p) => p.name).join(', ')} ${fast.length === 1 ? 'is' : 'are'} travelling fast` : 'Chunks are loading quickly',
      `${fast.length ? `${fast.map((p) => `${p.name} at ${p.speed} blocks/s`).join(', ')} (elytra, boats on ice or minecarts). ` : ''}${added ? `${plural(added, 'chunk')} loaded in a few seconds. ` : ''}New land has to be generated and loaded, which costs more than anything players do. Pre-generating the world (World → Worlds → Pre-generate) makes this cheap.`,
      { link: { label: 'Pre-generate', href: '#world/worlds' } });
  }

  // Memory: a nearly full heap means frequent and long garbage collection.
  if (r.heap && r.heap.used / r.heap.max >= 0.85) {
    add(r.heap.used / r.heap.max >= 0.95 ? 'critical' : 'warning', 'memory', 'Memory is almost full',
      `Java uses ${Math.round((r.heap.used / r.heap.max) * 100)}% of its ${Math.round(r.heap.max / 1073741824 * 10) / 10} GB after collecting garbage. The server spends more and more time cleaning up, which shows as lag spikes. Give it more memory, or find what holds it (often many loaded chunks or a plugin).`);
  }

  // Spikes: the average is fine but single ticks take very long.
  const max = r.mspt?.max ?? r.mspt?.p99;
  if (max != null && max >= 250 && (r.mspt.avg ?? 0) < 40) {
    add('warning', 'spikes', 'Short freezes', `Most ticks are quick (${r.mspt.avg ?? '?'} ms on average), but the slowest of the last minute took ${Math.round(max)} ms. That is the rubber-banding players feel; typical causes are garbage collection, saving the world and chunk generation.`);
  }

  // CPU: other processes, or a VM host that doesn't give us our share.
  const steal = r.cpu?.steal;
  if (steal != null && steal >= 0.08) {
    add(steal >= 0.2 ? 'critical' : 'warning', 'host', 'The VM host is busy', `${Math.round(steal * 100)}% of this machine's CPU time went to other machines on the same host (steal time). Nothing on the server can fix that; move the VM or give it dedicated cores.`);
  }
  if (r.cpu?.host != null && r.cpu.host >= 0.9 && r.cpu.process != null && r.cpu.process < r.cpu.cores * 0.5) {
    add('warning', 'host', 'Something else uses the CPU', `The machine is ${Math.round(r.cpu.host * 100)}% busy, but the Minecraft server itself uses only ${Math.round(r.cpu.process * 100) / 100} cores. Another program (a backup, a second server, a map renderer) competes for it.`);
  }

  // Simulation distance: many entity-ticking chunks per player.
  const ticking = (r.worlds || []).reduce((a, w) => a + (w.entityTicking || 0), 0);
  const n = (r.players || []).length;
  if (n && ticking / n > 450 && (r.settings?.simulationDistance ?? 0) > 8) {
    add('info', 'distance', 'A wide simulation distance', `${plural(ticking, 'chunk')} are fully simulated for ${plural(n, 'player')} (simulation-distance ${r.settings.simulationDistance}). Lowering it to 6 or 8 saves a lot and players hardly notice; view-distance can stay higher.`, { link: { label: 'Properties', href: '#server/properties' } });
  }

  // Not lagging right now: what was found could cause lag, but doesn't yet.
  r.lagging = (r.tps != null && r.tps < 18) || (r.mspt?.avg ?? 0) > 40;
  if (!r.lagging) for (const x of f) if (x.severity === 'critical') x.severity = 'warning';
  const order = { critical: 0, warning: 1, info: 2 };
  f.sort((a, b) => order[a.severity] - order[b.severity]);
  if (!f.length) {
    add('ok', 'none', 'Nothing stands out', `${r.tps != null ? `TPS ${r.tps.toFixed(1)}. ` : ''}No pile of entities, no fast travel, memory and CPU look fine. If it still lags, a spark profile shows which plugin or mechanic takes the time.`, { spark: true });
  } else if (r.lagging && !f.some((x) => x.severity === 'critical')) f.push({ severity: 'info', kind: 'spark', title: 'Not sure yet?', detail: 'A 30-second spark profile shows exactly what takes the time in each tick.', spark: true });
  return f;
}

module.exports = { LagDetective, diagnose, parseMspt, parseTickQuery, parseChunkInfo, parseEntityList, parseEntityChunks, parsePos, parseDim, parseCount };

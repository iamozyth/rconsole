'use strict';

// Prometheus text exposition for /metrics. Reads cached state; RCON is asked
// at most every few seconds however often Prometheus scrapes.

function line(out, name, help, type, value, labels = '') {
  if (value == null || (typeof value === 'number' && !Number.isFinite(value))) return;
  out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name}${labels} ${typeof value === 'boolean' ? Number(value) : value}`);
}

async function render({ metrics, stats, power, backups, maintenance, selfUpdate, updates }) {
  const out = [];
  const s = metrics.latest() || {};
  // Cached for 4 s, so frequent scrapes don't multiply RCON traffic.
  const cache = (await stats.get?.().catch(() => null)) || stats.cache || {};
  const host = cache.host || {};
  const game = cache.game || {};
  const st = await power.state().catch(() => ({}));
  line(out, 'rconsole_up', 'rconsole is running.', 'gauge', 1);
  line(out, 'minecraft_up', 'The Minecraft server is running (service active, or RCON reachable).', 'gauge', s.up ?? (cache.rcon?.ok ? 1 : 0));
  line(out, 'minecraft_rcon_up', 'RCON answered the last poll.', 'gauge', cache.rcon ? Number(cache.rcon.ok) : null);
  line(out, 'minecraft_tps', 'Ticks per second.', 'gauge', game.tps ?? s.tps);
  line(out, 'minecraft_mspt', 'Milliseconds per tick.', 'gauge', game.mspt ?? s.mspt);
  line(out, 'minecraft_players_online', 'Players online.', 'gauge', game.players?.online ?? s.players);
  line(out, 'minecraft_players_max', 'Player slots.', 'gauge', game.players?.max);
  line(out, 'minecraft_maintenance', 'Maintenance mode is on.', 'gauge', Boolean(maintenance.state().enabled));
  if (st.since) line(out, 'minecraft_start_time_seconds', 'When the server service last started.', 'gauge', Math.floor(Date.parse(st.since) / 1000));
  line(out, 'minecraft_process_resident_bytes', 'Resident memory of the Minecraft process.', 'gauge', s.rss);
  line(out, 'minecraft_process_cpu_ratio', 'CPU used by the Minecraft process (share of all cores).', 'gauge', s.pcpu);
  line(out, 'host_cpu_ratio', 'Host CPU usage.', 'gauge', host.cpu);
  if (host.mem) {
    line(out, 'host_memory_total_bytes', 'Host memory.', 'gauge', host.mem.total);
    line(out, 'host_memory_available_bytes', 'Host memory available.', 'gauge', host.mem.available);
  }
  if (host.disk) {
    line(out, 'host_disk_total_bytes', 'Size of the disk holding the server.', 'gauge', host.disk.total);
    line(out, 'host_disk_available_bytes', 'Free space on that disk.', 'gauge', host.disk.available);
  }
  try {
    const files = await backups.list();
    line(out, 'minecraft_backups', 'Backups kept.', 'gauge', files.length);
    line(out, 'minecraft_backups_bytes', 'Total size of the backups.', 'gauge', files.reduce((n, f) => n + f.size, 0));
    if (files[0]) line(out, 'minecraft_backup_last_timestamp_seconds', 'Time of the newest backup.', 'gauge', Math.floor(Date.parse(files[0].created) / 1000));
  } catch {}
  line(out, 'minecraft_backup_last_failed', 'The last backup attempt failed.', 'gauge', Boolean(backups.state.lastError));
  const paper = updates.lastOverview;
  if (paper) line(out, 'minecraft_paper_builds_available', 'Newer Paper builds for the installed version.', 'gauge', paper.newerBuilds?.length ?? 0);
  line(out, 'rconsole_commits_behind', 'rconsole commits available on GitHub.', 'gauge', selfUpdate.summary().available);
  return `${out.join('\n')}\n`;
}

module.exports = { render };

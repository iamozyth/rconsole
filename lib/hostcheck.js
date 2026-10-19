'use strict';

// Conditions of the machine that hurt the servers, shown under Problems
// while they last: swapping (garbage collection then stalls the server),
// almost no memory left, and RCON ports that other machines can reach.

const fs = require('fs');

const MB = 1024 * 1024;

function meminfo(text) {
  const kb = (key) => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1]) * 1024;
  return { total: kb('MemTotal'), available: kb('MemAvailable'), swapTotal: kb('SwapTotal'), swapFree: kb('SwapFree') };
}

// Ports with a TCP socket listening on every address (0.0.0.0 or ::), from
// /proc/net/tcp and tcp6.
function wildcardListeners(tcp = '', tcp6 = '') {
  const ports = new Set();
  for (const [text, any] of [[tcp, '00000000'], [tcp6, '00000000000000000000000000000000']]) {
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 4 || f[3] !== '0A') continue; // 0A = LISTEN
      const [addr, port] = f[1].split(':');
      if (addr === any) ports.add(parseInt(port, 16));
    }
  }
  return ports;
}

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

// rcon: [{ name, port }] of the servers rconsole knows. firewall: the
// status rconsole-limits.service wrote, or null.
function check({ rcon = [], firewall = null, mem = meminfo(read('/proc/meminfo')), listening = wildcardListeners(read('/proc/net/tcp'), read('/proc/net/tcp6')) } = {}) {
  const out = [];
  const swapUsed = (mem.swapTotal || 0) - (mem.swapFree || 0);
  if (swapUsed > 256 * MB) {
    out.push({ title: 'The machine is swapping', message: `${Math.round(swapUsed / MB)} MB of memory is in swap. Java's garbage collection then has to read the heap back from disk, and the server stalls. Give the servers less memory or the machine more RAM.` });
  } else if (mem.total && mem.available < Math.max(256 * MB, mem.total * 0.05)) {
    out.push({ title: 'Almost no memory left', message: `${Math.round(mem.available / MB)} MB of ${Math.round(mem.total / MB)} MB is free${mem.swapTotal ? '' : ' and there is no swap'}. The next spike makes the kernel stop a process; rconsole's servers go first. Give the servers less memory.` });
  }
  const closed = new Set(firewall?.firewall === 'on' ? firewall.closed : []);
  const open = rcon.filter((r) => r.port && listening.has(r.port) && !closed.has(r.port));
  if (open.length) {
    const why = firewall?.firewall === 'off' ? 'RCON_FIREWALL is off' : firewall?.firewall === 'missing' ? 'nftables is not installed (apt install nftables)' : 'rconsole-limits.service has not closed it';
    out.push({ title: 'RCON reachable from other machines', message: `${open.map((r) => `${r.name} (port ${r.port})`).join(', ')} accept${open.length === 1 ? 's' : ''} RCON on every network address and ${why}. RCON sends its password in plain text; only rconsole on this machine needs it.` });
  }
  return out.map((c) => ({ kind: 'host', severity: 'warning', ...c }));
}

module.exports = { check, meminfo, wildcardListeners };

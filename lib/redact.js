'use strict';

// Player addresses are for moderators and admins (see ROLE_RULES in
// server.js). Viewers still read the log, the log search and the ban list,
// with the addresses masked.

// IPv4 with valid octets, not part of a longer dotted number (versions).
const IPV4 = /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])/g;
// IPv6 only where Minecraft prints a connection address: "[/addr:port]" or "/addr:port".
const SLASH_ADDR = /(?<=[[(\s]\/)(?:\[[0-9A-Fa-f:.%]+\](?::\d+)?|[0-9A-Fa-f.%]*:[0-9A-Fa-f:.%]*)(?=[\])\s,]|$)/g;
const MASK = '•••';

const maskIps = (s) => String(s).replace(SLASH_ADDR, MASK).replace(IPV4, MASK);

// A copy of `value` with every string masked.
function maskDeep(value) {
  if (typeof value === 'string') return maskIps(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)]));
  return value;
}

module.exports = { maskIps, maskDeep, MASK };

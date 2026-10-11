'use strict';

// Reads Minecraft's whitelist, ops and ban lists straight from the server
// directory. Changes go through RCON so the server stays the source of truth.

const fs = require('fs');
const path = require('path');

async function readJson(file) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`Cannot read ${path.basename(file)}: ${err.message}`);
  }
}

async function readProperties(mcDir) {
  const props = {};
  try {
    const text = await fs.promises.readFile(path.join(mcDir, 'server.properties'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([^#=\s][^=]*?)\s*=\s*(.*?)\s*$/);
      if (m) props[m[1]] = m[2];
    }
  } catch {}
  return props;
}

async function readAccess(mcDir) {
  const [whitelist, ops, bans, ipBans, props] = await Promise.all([
    readJson(path.join(mcDir, 'whitelist.json')),
    readJson(path.join(mcDir, 'ops.json')),
    readJson(path.join(mcDir, 'banned-players.json')),
    readJson(path.join(mcDir, 'banned-ips.json')),
    readProperties(mcDir),
  ]);
  return {
    whitelistEnabled: props['white-list'] === 'true',
    whitelist: whitelist.map(({ name, uuid }) => ({ name, uuid })),
    ops: ops.map(({ name, uuid, level }) => ({ name, uuid, level })),
    bans: bans.map(({ name, uuid, reason, source, created, expires }) => ({ name, uuid, reason, source, created, expires })),
    ipBans: ipBans.map(({ ip, reason, source, created, expires }) => ({ ip, reason, source, created, expires })),
  };
}

module.exports = { readAccess, readProperties };

'use strict';

// Names shared by rconsole and the privileged helper. Both sides validate.

const WORLD_RE = /^[A-Za-z0-9_-]{1,32}$/;
const DIMENSIONS = ['', '_nether', '_the_end'];
const STAMP_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;
// <world>-<YYYY-MM-DD_HH-MM-SS>.tar.gz; pre-1.4 backups are "world-<stamp>".
const BACKUP_RE = /^([A-Za-z0-9_-]{1,32})-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.tar\.gz$/;
const JOB_ID_RE = /^[a-f0-9]{32}$/;

function isWorldName(name) {
  return WORLD_RE.test(name) && !/_(nether|the_end)$/.test(name) && !/^\.|^-/.test(name);
}

function parseBackupName(name) {
  const m = BACKUP_RE.exec(String(name));
  return m && isWorldName(m[1]) ? { world: m[1], stamp: m[2] } : null;
}

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

module.exports = { WORLD_RE, DIMENSIONS, STAMP_RE, BACKUP_RE, JOB_ID_RE, isWorldName, parseBackupName, timestamp };

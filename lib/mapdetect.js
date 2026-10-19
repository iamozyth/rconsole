'use strict';

// Which web map plugin the server runs and where it listens, read from the
// plugins' own config files, so the Map tab can offer to use it instead of
// telling the admin to install another one.

const fs = require('fs');
const path = require('path');

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const LOCAL = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/;

// HOCON (BlueMap): `port: 8100`, `ip: "127.0.0.1"`, `enabled: false`.
const hocon = (text, key) => text.match(new RegExp(`^\\s*${key}\\s*[:=]\\s*"?([^"\\s#]+)"?`, 'm'))?.[1] ?? null;

function bluemap(dir) {
  const text = read(path.join(dir, 'plugins', 'BlueMap', 'webserver.conf'));
  if (text === null || hocon(text, 'enabled') === 'false') return null;
  return { plugin: 'BlueMap', port: Number(hocon(text, 'port')) || 8100, bind: hocon(text, 'ip') || '0.0.0.0', config: 'plugins/BlueMap/webserver.conf', bindKey: 'ip: "127.0.0.1"' };
}

// squaremap's config.yml: settings.internal-webserver.{enabled,bind,port}.
function squaremap(dir) {
  const text = read(path.join(dir, 'plugins', 'squaremap', 'config.yml'));
  if (text === null) return null;
  const block = text.match(/internal-webserver:\n((?:[ \t]+.*\n?)+)/)?.[1] || '';
  if (/^\s*enabled:\s*false/m.test(block)) return null;
  const bind = block.match(/^\s*bind:\s*['"]?([^'"\s#]+)/m)?.[1] || '0.0.0.0';
  return { plugin: 'squaremap', port: Number(block.match(/^\s*port:\s*(\d+)/m)?.[1]) || 8080, bind, config: 'plugins/squaremap/config.yml', bindKey: 'internal-webserver.bind: 127.0.0.1' };
}

// Dynmap's configuration.txt: webserver-port, webserver-bindaddress.
function dynmap(dir) {
  const text = read(path.join(dir, 'plugins', 'dynmap', 'configuration.txt'));
  if (text === null || /^\s*disable-webserver:\s*true/m.test(text)) return null;
  return {
    plugin: 'Dynmap',
    port: Number(text.match(/^\s*webserver-port:\s*(\d+)/m)?.[1]) || 8123,
    bind: text.match(/^\s*webserver-bindaddress:\s*['"]?([^'"\s#]+)/m)?.[1] || '0.0.0.0',
    config: 'plugins/dynmap/configuration.txt',
    bindKey: 'webserver-bindaddress: 127.0.0.1',
  };
}

function detect(mcDir) {
  return [bluemap, squaremap, dynmap]
    .map((f) => f(mcDir))
    .filter((m) => m && m.port > 0 && m.port < 65536)
    .map((m) => ({ ...m, url: `http://127.0.0.1:${m.port}`, private: LOCAL.test(m.bind) }));
}

// A map URL rconsole may proxy: on this machine only, so the setting can't
// turn rconsole into a way into other hosts.
const MAP_URL_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})(\/[\w./-]*)?$/;
const validMapUrl = (url) => MAP_URL_RE.test(url) && Number(url.match(MAP_URL_RE)[2]) < 65536;

module.exports = { detect, validMapUrl };

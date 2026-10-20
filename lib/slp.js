'use strict';

// Server List Ping: what the multiplayer screen asks a server (players
// online, version), without RCON. The dashboard uses it for the servers
// rconsole doesn't show, so it can count their players too.

const net = require('net');

const TIMEOUT_MS = 1500;
const MAX_BYTES = 256 * 1024; // favicons make answers big; more is not a server

function varint(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

// [value, bytes read], or null while the buffer holds too little.
function readVarint(buf, at = 0) {
  let n = 0;
  for (let i = 0; i < 5; i++) {
    if (at + i >= buf.length) return null;
    const b = buf[at + i];
    n |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return [n, i + 1];
  }
  throw new Error('bad varint');
}

const packet = (...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([varint(body.length), body]);
};
const str = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([varint(b.length), b]);
};

// The status answer of the server at host:port, or a rejection.
function ping({ host = '127.0.0.1', port, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    const done = (err, value) => {
      clearTimeout(timer);
      sock.destroy();
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => done(new Error('timed out')), timeoutMs);
    sock.on('error', (err) => done(err));
    sock.on('connect', () => {
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      // Handshake (protocol -1: "just asking"), next state 1 = status; then the request.
      sock.write(Buffer.concat([packet(varint(0), varint(-1), str(host), portBuf, varint(1)), packet(varint(0))]));
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_BYTES) return done(new Error('answer too large'));
      try {
        const len = readVarint(buf);
        if (!len || buf.length < len[1] + len[0]) return;
        let at = len[1];
        const id = readVarint(buf, at);
        at += id[1];
        if (id[0] !== 0) return done(new Error('unexpected packet'));
        const slen = readVarint(buf, at);
        at += slen[1];
        const status = JSON.parse(buf.subarray(at, at + slen[0]).toString('utf8'));
        done(null, {
          online: Number(status.players?.online) || 0,
          max: Number(status.players?.max) || 0,
          sample: (status.players?.sample || []).map((p) => String(p.name || '')).filter((n) => /^[A-Za-z0-9_]{1,16}$/.test(n)).slice(0, 12),
          version: typeof status.version?.name === 'string' ? status.version.name.slice(0, 64) : null,
        });
      } catch (err) {
        done(err);
      }
    });
  });
}

module.exports = { ping, varint, readVarint };

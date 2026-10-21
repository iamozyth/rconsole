'use strict';

// Stands in for a sleeping Minecraft server on its port: the multiplayer
// screen shows it as sleeping, and a player who joins wakes it. Speaks just
// enough of the protocol: the handshake, the status request and ping, and
// Login Start, answered with a Disconnect that tells the player to join
// again in a moment. Nothing is ever read beyond a few small packets.

const net = require('net');
const { varint, readVarint } = require('./slp');

const MAX_PACKET = 2048;
const IDLE_MS = 5000;
const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;

const str = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([varint(b.length), b]);
};
const packet = (...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([varint(body.length), body]);
};

// Reads the packets in `buf`: [{ id, body }], and the bytes left over.
function packets(buf) {
  const out = [];
  let at = 0;
  for (;;) {
    const len = readVarint(buf, at);
    if (!len) break;
    if (len[0] < 1 || len[0] > MAX_PACKET) throw new Error('bad packet');
    if (buf.length < at + len[1] + len[0]) break;
    const start = at + len[1];
    const id = readVarint(buf, start);
    if (!id) throw new Error('bad packet');
    out.push({ id: id[0], body: buf.subarray(start + id[1], start + len[0]) });
    at = start + len[0];
  }
  return { list: out, rest: buf.subarray(at) };
}

function readString(body, at) {
  const n = readVarint(body, at);
  if (!n || n[0] > 1024 || body.length < at + n[1] + n[0]) throw new Error('bad string');
  return [body.toString('utf8', at + n[1], at + n[1] + n[0]), at + n[1] + n[0]];
}

// status(): { motd, version, max, favicon? }; onLogin(name, ip) -> the text
// to disconnect the player with.
function listen({ port, host, status, onLogin, log = () => {} }) {
  const open = new Set();
  const server = net.createServer((sock) => {
    open.add(sock);
    sock.on('close', () => open.delete(sock));
    let buf = Buffer.alloc(0);
    let state = 'handshake';
    let protocol = 0;
    sock.setTimeout(IDLE_MS, () => sock.destroy());
    sock.on('error', () => {});
    sock.on('data', async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_PACKET * 2) return sock.destroy();
      if (state === 'handshake' && buf[0] === 0xfe) return sock.destroy(); // pre-1.7 ping
      let parsed;
      try {
        parsed = packets(buf);
      } catch {
        return sock.destroy();
      }
      buf = parsed.rest;
      for (const { id, body } of parsed.list) {
        try {
          if (state === 'handshake') {
            if (id !== 0) return sock.destroy();
            const p = readVarint(body, 0);
            protocol = p[0] | 0;
            const [, at] = readString(body, p[1]);
            const next = readVarint(body, at + 2);
            state = next?.[0] === 1 ? 'status' : next?.[0] === 2 || next?.[0] === 3 ? 'login' : null;
            if (!state) return sock.destroy();
          } else if (state === 'status' && id === 0) {
            const s = status();
            const json = {
              version: { name: s.version, protocol: protocol > 0 ? protocol : 0 },
              players: { online: 0, max: s.max ?? 20, sample: [] },
              description: { text: s.motd },
              ...(s.favicon ? { favicon: s.favicon } : {}),
            };
            sock.write(packet(varint(0), str(JSON.stringify(json))));
          } else if (state === 'status' && id === 1) {
            sock.end(packet(varint(1), body.subarray(0, 8)));
            return;
          } else if (state === 'login' && id === 0) {
            const [name] = readString(body, 0);
            state = 'done';
            const text = NAME_RE.test(name) ? await onLogin(name, sock.remoteAddress) : 'Invalid name';
            sock.end(packet(varint(0), str(JSON.stringify(typeof text === 'string' ? { text } : text))));
            return;
          } else return sock.destroy();
        } catch (err) {
          log(`sleep: ${err.message}`);
          return sock.destroy();
        }
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: host || undefined, exclusive: true }, () => {
      server.removeListener('error', reject);
      server.on('error', (err) => log(`sleep: listener on ${port}: ${err.message}`));
      resolve({
        // Connections still open (a slow client) go too, so the port is free.
        close: () => new Promise((r) => {
          server.close(() => r());
          for (const s of open) s.destroy();
        }),
      });
    });
  });
}

module.exports = { listen, packets };

'use strict';

// Client-side encryption for offsite backups: AES-256-GCM in 1 MiB chunks,
// key derived from a passphrase with scrypt. Each chunk is authenticated with
// its index and a final-chunk flag, so chunks can't be reordered, dropped or
// cut off at the end without decryption failing.
//
// Format: "RCENC1" | salt (16) | nonce prefix (8) | chunk size (u32 BE)
//         then per chunk: length (u32 BE) | ciphertext | tag (16)

const crypto = require('crypto');
const { Transform } = require('stream');

const MAGIC = Buffer.from('RCENC1');
const HEADER = MAGIC.length + 16 + 8 + 4;
const CHUNK = 1024 * 1024;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const deriveKey = (passphrase, salt) => crypto.scryptSync(String(passphrase), salt, 32, SCRYPT);

function nonceFor(prefix, index) {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(index, 8);
  return n;
}
const aadFor = (index, final) => {
  const a = Buffer.alloc(5);
  a.writeUInt32BE(index, 0);
  a[4] = final ? 1 : 0;
  return a;
};

function encryptStream(passphrase) {
  const salt = crypto.randomBytes(16);
  const prefix = crypto.randomBytes(8);
  const key = deriveKey(passphrase, salt);
  let pending = Buffer.alloc(0);
  let index = 0;
  const seal = (data, final) => {
    const c = crypto.createCipheriv('aes-256-gcm', key, nonceFor(prefix, index));
    c.setAAD(aadFor(index, final));
    const body = Buffer.concat([c.update(data), c.final()]);
    index++;
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    return Buffer.concat([len, body, c.getAuthTag()]);
  };
  const head = Buffer.alloc(4);
  head.writeUInt32BE(CHUNK);
  let started = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (!started) {
        this.push(Buffer.concat([MAGIC, salt, prefix, head]));
        started = true;
      }
      pending = Buffer.concat([pending, chunk]);
      // Keep at least one byte back so the last chunk can be marked final.
      while (pending.length > CHUNK) {
        this.push(seal(pending.subarray(0, CHUNK), false));
        pending = pending.subarray(CHUNK);
      }
      cb();
    },
    flush(cb) {
      if (!started) this.push(Buffer.concat([MAGIC, salt, prefix, head]));
      this.push(seal(pending, true));
      cb();
    },
  });
}

function decryptStream(passphrase) {
  let buf = Buffer.alloc(0);
  let key = null;
  let prefix = null;
  let index = 0;
  const open = (data, tag, final) => {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonceFor(prefix, index));
    d.setAAD(aadFor(index, final));
    d.setAuthTag(tag);
    index++;
    try {
      return Buffer.concat([d.update(data), d.final()]);
    } catch {
      throw new Error('Wrong passphrase or damaged backup');
    }
  };
  return new Transform({
    transform(chunk, _enc, cb) {
      buf = Buffer.concat([buf, chunk]);
      try {
        if (!key) {
          if (buf.length < HEADER) return cb();
          if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an rconsole encrypted backup');
          key = deriveKey(passphrase, buf.subarray(6, 22));
          prefix = Buffer.from(buf.subarray(22, 30));
          buf = buf.subarray(HEADER);
        }
        // A chunk is only known not to be the last once a byte follows it.
        for (;;) {
          if (buf.length < 4) break;
          const len = buf.readUInt32BE(0);
          if (buf.length < 4 + len + 16 + 1) break;
          this.push(open(buf.subarray(4, 4 + len), buf.subarray(4 + len, 4 + len + 16), false));
          buf = buf.subarray(4 + len + 16);
        }
        cb();
      } catch (err) {
        cb(err);
      }
    },
    flush(cb) {
      try {
        if (!key) throw new Error('Not an rconsole encrypted backup');
        const len = buf.length >= 4 ? buf.readUInt32BE(0) : -1;
        if (len < 0 || buf.length !== 4 + len + 16) throw new Error('Encrypted backup is truncated');
        this.push(open(buf.subarray(4, 4 + len), buf.subarray(4 + len), true));
        cb();
      } catch (err) {
        cb(err);
      }
    },
  });
}

const isEncrypted = (head) => head.length >= MAGIC.length && head.subarray(0, MAGIC.length).equals(MAGIC);

module.exports = { encryptStream, decryptStream, isEncrypted, CHUNK };

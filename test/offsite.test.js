'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Offsite, SECRET } = require('../lib/offsite');

// A minimal S3: single PUT, multipart, list-type=2, GET, DELETE.
function fakeS3() {
  const objects = new Map();
  const uploads = new Map();
  const seen = [];
  let failNext = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const [, bucket, ...rest] = u.pathname.split('/');
    const key = rest.map(decodeURIComponent).join('/');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push(`${req.method} ${u.search.includes('uploads') ? 'init' : u.searchParams.has('partNumber') ? 'part' : u.searchParams.has('uploadId') ? 'complete' : key || 'list'}`);
      if (!req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ') || bucket !== 'backups') return res.writeHead(403).end('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');
      if (failNext > 0 && req.method === 'PUT') {
        failNext--;
        return res.writeHead(500).end('<Error><Code>InternalError</Code><Message>try again</Message></Error>');
      }
      const body = Buffer.concat(chunks);
      if (req.method === 'POST' && u.searchParams.has('uploads')) {
        const id = crypto.randomBytes(6).toString('hex');
        uploads.set(id, []);
        return res.end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      }
      if (req.method === 'PUT' && u.searchParams.has('partNumber')) {
        uploads.get(u.searchParams.get('uploadId'))[Number(u.searchParams.get('partNumber')) - 1] = body;
        return res.writeHead(200, { etag: `"p${u.searchParams.get('partNumber')}"` }).end();
      }
      if (req.method === 'POST' && u.searchParams.has('uploadId')) {
        objects.set(key, Buffer.concat(uploads.get(u.searchParams.get('uploadId'))));
        return res.end('<CompleteMultipartUploadResult/>');
      }
      if (req.method === 'PUT') {
        objects.set(key, body);
        return res.writeHead(200, { etag: '"x"' }).end();
      }
      if (req.method === 'GET' && !key) {
        const prefix = u.searchParams.get('prefix') || '';
        const items = [...objects].filter(([k]) => k.startsWith(prefix));
        return res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${items.map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size><LastModified>2026-10-13T10:00:00.000Z</LastModified></Contents>`).join('')}</ListBucketResult>`);
      }
      if (req.method === 'GET') return objects.has(key) ? res.end(objects.get(key)) : res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
      if (req.method === 'DELETE') {
        objects.delete(key);
        return res.writeHead(204).end();
      }
      res.writeHead(400).end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, objects, seen, url: `http://127.0.0.1:${server.address().port}`, fail: (n) => (failNext = n) })));
}

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('offsite: encrypted upload after a backup, list, retention, download and decrypt', async () => {
  const s3 = await fakeS3();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-offsite-'));
  const results = [];
  const o = new Offsite({ stateDir: dir, backupDir: dir, env: {}, onResult: (r) => results.push(r) });
  assert.throws(() => o.enqueue('world-2026-10-13_10-00-00.tar.gz'), /not set up/);
  assert.throws(() => o.update({ endpoint: 'ftp://x' }), /http/);
  const view = o.update({ endpoint: s3.url, bucket: 'backups', accessKeyId: 'AK', secretAccessKey: 'SK', passphrase: 'pw', auto: true, keep: 2 });
  assert.strictEqual(view.secretAccessKey, SECRET);
  assert.strictEqual(fs.statSync(path.join(dir, 'offsite.json')).mode & 0o777, 0o600);
  o.update({ secretAccessKey: SECRET }); // unchanged secret is kept
  assert.strictEqual(o.config.secretAccessKey, 'SK');

  const data = crypto.randomBytes(20 * 1024 * 1024 + 7); // more than one 16 MiB part
  const files = ['world-2026-10-11_10-00-00.tar.gz', 'world-2026-10-12_10-00-00.tar.gz', 'world-2026-10-13_10-00-00.tar.gz'];
  for (const f of files) fs.writeFileSync(path.join(dir, f), f.endsWith('13_10-00-00.tar.gz') ? data : Buffer.from(f));
  for (const f of files) o.onBackup(f);
  await until(() => results.length === 3);
  assert.ok(results.every((r) => r.ok));
  assert.ok(s3.seen.includes('PUT part'));

  const list = await o.list();
  assert.deepStrictEqual(list.map((x) => x.name), ['world-2026-10-13_10-00-00.tar.gz.enc', 'world-2026-10-12_10-00-00.tar.gz.enc']); // keep: 2
  assert.ok(!s3.objects.get('rconsole/world-2026-10-13_10-00-00.tar.gz.enc').includes(data.subarray(0, 64)));

  fs.rmSync(path.join(dir, files[2]));
  await o.download(list[0].name);
  assert.ok(fs.readFileSync(path.join(dir, files[2])).equals(data));
  await assert.rejects(o.download(list[0].name), /already in the backup folder/);
  await assert.rejects(o.download('../../etc/passwd'), /Invalid backup name/);
  o.update({ passphrase: 'wrong' });
  fs.rmSync(path.join(dir, files[1]));
  await assert.rejects(o.download(list[1].name), /Wrong passphrase/);
  assert.ok(!fs.existsSync(path.join(dir, files[1])));
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.part')), []);
  s3.server.close();
});

test('offsite: a failed upload is retried and reported', async () => {
  const s3 = await fakeS3();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-offsite-'));
  const results = [];
  const o = new Offsite({ stateDir: dir, backupDir: dir, env: {}, onResult: (r) => results.push(r) });
  o.update({ endpoint: s3.url, bucket: 'backups', accessKeyId: 'AK', secretAccessKey: 'SK' });
  fs.writeFileSync(path.join(dir, 'world-2026-10-13_10-00-00.tar.gz'), 'tar');
  s3.fail(1);
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms > 1000 ? 10 : ms, ...a); // retry at once
  try {
    o.enqueue('world-2026-10-13_10-00-00.tar.gz');
    await until(() => results.length === 1);
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.deepStrictEqual(results, [{ ok: true, file: 'world-2026-10-13_10-00-00.tar.gz' }]);
  assert.strictEqual(s3.objects.get('rconsole/world-2026-10-13_10-00-00.tar.gz').toString(), 'tar');
  s3.server.close();
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { sign } = require('../lib/s3');
const { encryptStream, decryptStream, CHUNK } = require('../lib/crypt');

const creds = { region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', date: new Date('2013-05-24T00:00:00Z') };
const sig = (h) => h.authorization.match(/Signature=([0-9a-f]+)/)[1];

// Examples from the AWS S3 documentation, "Signature Calculations for the
// Authorization Header".
test('s3: SigV4 matches the AWS documentation examples', () => {
  const get = sign({ ...creds, method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { range: 'bytes=0-9' } });
  assert.strictEqual(sig(get), 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.match(get.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
  const list = sign({ ...creds, method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/', query: { 'max-keys': '2', prefix: 'J' } });
  assert.strictEqual(sig(list), '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
});

async function run(stream, input) {
  const out = [];
  await pipeline(Readable.from(input), stream, async function* (src) {
    for await (const c of src) out.push(c);
  });
  return Buffer.concat(out);
}

test('crypt: round trip for empty, small and multi-chunk data; wrong key and tampering fail', async () => {
  for (const size of [0, 10, CHUNK, CHUNK * 2 + 123]) {
    const data = crypto.randomBytes(size);
    const sealed = await run(encryptStream('correct horse'), [data.subarray(0, 7), data.subarray(7)]);
    assert.ok(sealed.length > size);
    assert.deepStrictEqual(await run(decryptStream('correct horse'), [sealed]), data);
  }
  const data = crypto.randomBytes(CHUNK + 50);
  const sealed = await run(encryptStream('pw'), [data]);
  await assert.rejects(run(decryptStream('nope'), [sealed]), /Wrong passphrase/);
  const flipped = Buffer.from(sealed);
  flipped[100] ^= 1;
  await assert.rejects(run(decryptStream('pw'), [flipped]), /Wrong passphrase or damaged/);
  // Cutting off the last chunk must not pass as a complete file.
  const firstChunkEnd = 34 + 4 + CHUNK + 16;
  await assert.rejects(run(decryptStream('pw'), [sealed.subarray(0, firstChunkEnd)]), /truncated|damaged/);
  await assert.rejects(run(decryptStream('pw'), [Buffer.from('plain tar.gz data')]), /Not an rconsole encrypted backup/);
});

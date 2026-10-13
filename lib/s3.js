'use strict';

// A small S3 client for any S3-compatible store (AWS, Backblaze B2,
// Cloudflare R2, Wasabi, MinIO): Signature Version 4, path-style or
// virtual-host addressing, multipart uploads, listing, download, delete.
// Node's standard library only.

const crypto = require('crypto');
const http = require('http');
const https = require('https');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const EMPTY_HASH = sha256('');

// RFC 3986 encoding as S3 expects it; '/' stays in paths.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// Signs a request; returns the headers to send (including Authorization).
function sign({ method, host, path, query = {}, headers = {}, payloadHash = EMPTY_HASH, region, accessKeyId, secretAccessKey, date = new Date() }) {
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const all = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(all).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const canonicalQuery = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k] ?? '')}`).join('&');
  const canonical = [method, path.split('/').map((p) => enc(decodeURIComponent(p))).join('/'), canonicalQuery, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return {
    ...Object.fromEntries(Object.entries(all).filter(([k]) => k !== 'host')),
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

const xmlAll = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
const xmlOne = (xml, tag) => xmlAll(xml, tag)[0];
const unxml = (s) => (s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

class S3 {
  // endpoint: e.g. https://s3.eu-central-003.backblazeb2.com
  constructor({ endpoint, region = 'us-east-1', bucket, accessKeyId, secretAccessKey, pathStyle = true, timeoutMs = 120000 }) {
    const u = new URL(endpoint);
    if (!/^https?:$/.test(u.protocol)) throw new Error('Endpoint must be an http(s) URL');
    Object.assign(this, { url: u, region: region || 'us-east-1', bucket, accessKeyId, secretAccessKey, pathStyle, timeoutMs });
  }

  target(key = '') {
    const host = this.pathStyle ? this.url.host : `${this.bucket}.${this.url.host}`;
    const base = this.url.pathname.replace(/\/$/, '');
    const path = `${base}${this.pathStyle ? `/${this.bucket}` : ''}/${key.split('/').map((p) => enc(p)).join('/')}`;
    return { host, path };
  }

  // body: Buffer or undefined. Resolves { status, headers, body } (Buffer), or
  // with stream: true the response itself.
  request(method, key, { query = {}, body, headers = {}, stream = false } = {}) {
    const { host, path } = this.target(key);
    const payloadHash = body ? sha256(body) : EMPTY_HASH;
    const signed = sign({ method, host, path, query, headers: { ...headers, ...(body ? { 'content-length': body.length } : {}) }, payloadHash, region: this.region, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey });
    const qs = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k] ?? '')}`).join('&');
    const lib = this.url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request({ method, host: this.url.hostname, port: this.url.port || undefined, path: `${path}${qs ? `?${qs}` : ''}`, headers: { ...signed, host }, servername: host.split(':')[0] }, (res) => {
        if (stream && res.statusCode < 300) return resolve(res);
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode >= 300) {
            const text = buf.toString('utf8');
            const err = new Error(`S3 ${method} ${key || '/'}: ${unxml(xmlOne(text, 'Message')) || unxml(xmlOne(text, 'Code')) || `HTTP ${res.statusCode}`}`);
            err.status = res.statusCode;
            err.code = xmlOne(text, 'Code');
            return reject(err);
          }
          resolve({ status: res.statusCode, headers: res.headers, body: buf });
        });
        res.on('error', reject);
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error('S3 request timed out')));
      req.on('error', reject);
      req.end(body);
    });
  }

  async list(prefix = '') {
    const out = [];
    let token;
    do {
      const { body } = await this.request('GET', '', { query: { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) } });
      const xml = body.toString('utf8');
      for (const c of xmlAll(xml, 'Contents')) {
        out.push({ key: unxml(xmlOne(c, 'Key')), size: Number(xmlOne(c, 'Size')), modified: xmlOne(c, 'LastModified') });
      }
      token = xmlOne(xml, 'IsTruncated') === 'true' ? unxml(xmlOne(xml, 'NextContinuationToken')) : null;
    } while (token);
    return out;
  }

  remove(key) {
    return this.request('DELETE', key);
  }

  download(key) {
    return this.request('GET', key, { stream: true });
  }

  // Uploads a readable stream in parts of `partSize` (min 5 MiB except the
  // last); one PUT for small files. Aborts the upload on failure.
  async upload(key, readable, { partSize = 16 * 1024 * 1024, onProgress = () => {} } = {}) {
    let buf = Buffer.alloc(0);
    let uploadId = null;
    const parts = [];
    let sent = 0;
    const putPart = async (data) => {
      if (!uploadId) {
        const { body } = await this.request('POST', key, { query: { uploads: '' } });
        uploadId = unxml(xmlOne(body.toString('utf8'), 'UploadId'));
        if (!uploadId) throw new Error('S3 did not return an upload id');
      }
      const n = parts.length + 1;
      const { headers } = await this.request('PUT', key, { query: { partNumber: String(n), uploadId }, body: data });
      parts.push({ n, etag: headers.etag });
      sent += data.length;
      onProgress(sent);
    };
    try {
      for await (const chunk of readable) {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= partSize) {
          await putPart(buf.subarray(0, partSize));
          buf = buf.subarray(partSize);
        }
      }
      if (!uploadId) {
        await this.request('PUT', key, { body: buf });
        onProgress(buf.length);
        return { key, size: buf.length, parts: 1 };
      }
      if (buf.length) await putPart(buf);
      const xml = `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
      await this.request('POST', key, { query: { uploadId }, body: Buffer.from(xml) });
      return { key, size: sent, parts: parts.length };
    } catch (err) {
      if (uploadId) await this.request('DELETE', key, { query: { uploadId } }).catch(() => {});
      throw err;
    }
  }
}

module.exports = { S3, sign, sha256 };

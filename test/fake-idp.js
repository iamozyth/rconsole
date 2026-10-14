'use strict';

// A small OpenID Connect provider for tests and the demo: discovery, JWKS,
// an authorize endpoint that signs the configured user in at once, a token
// endpoint that checks client auth and PKCE, userinfo and end_session.
// `idp.user` is who signs in next; `idp.tamper` breaks the next ID token.

const crypto = require('crypto');
const http = require('http');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function fakeIdp({ clientId = 'rconsole', clientSecret = 'idp-secret', port = 0 } = {}) {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const rotated = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = (k, kid, alg) => ({ ...k.publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' });
  const codes = new Map();
  const idp = {
    user: { sub: 'u-1', preferred_username: 'masseo', name: 'Masseo', email: 'masseo@example.com', groups: ['rconsole-admins'] },
    alg: 'RS256',
    tamper: {},
    groupsInIdToken: true,
    publishRotated: false,
    jwksFetches: 0,
    tokenRequests: [],
  };

  const sign = (claims) => {
    const t = idp.tamper;
    const alg = t.alg || idp.alg;
    const kid = t.kid || { RS256: 'rsa-1', PS256: 'rsa-1', ES256: 'ec-1' }[alg] || 'rsa-1';
    const header = { alg, kid, typ: 'JWT' };
    const data = `${b64(header)}.${b64(claims)}`;
    let sig;
    if (alg === 'none') sig = '';
    else if (alg === 'HS256') sig = crypto.createHmac('sha256', clientSecret).update(data).digest('base64url');
    else {
      const key = t.kid === 'rsa-2' ? rotated.privateKey : alg === 'ES256' ? ec.privateKey : rsa.privateKey;
      const opts = alg === 'PS256' ? { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 } : alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key;
      sig = crypto.sign('sha256', Buffer.from(data), opts).toString('base64url');
    }
    if (t.badSig) sig = `${sig.slice(0, -4)}AAAA`;
    return `${data}.${sig}`;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, idp.issuer);
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/application/o/rconsole/.well-known/openid-configuration') {
      return json(200, {
        issuer: idp.issuer,
        authorization_endpoint: `${idp.origin}/authorize`,
        token_endpoint: `${idp.origin}/token`,
        userinfo_endpoint: `${idp.origin}/userinfo`,
        jwks_uri: `${idp.origin}/jwks`,
        end_session_endpoint: `${idp.origin}/end-session`,
        id_token_signing_alg_values_supported: ['RS256', 'ES256'],
      });
    }
    if (url.pathname === '/jwks') {
      idp.jwksFetches++;
      return json(200, { keys: [jwk(rsa, 'rsa-1', undefined), jwk(ec, 'ec-1', 'ES256'), ...(idp.publishRotated ? [jwk(rotated, 'rsa-2', 'RS256')] : [])] });
    }
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      if (p.get('client_id') !== clientId || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) return json(400, { error: 'invalid_request' });
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, { nonce: p.get('nonce'), challenge: p.get('code_challenge'), redirect: p.get('redirect_uri'), user: { ...idp.user } });
      const back = new URL(p.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', p.get('state'));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const p = new URLSearchParams(body);
        idp.tokenRequests.push(Object.fromEntries(p));
        const [id, secret] = Buffer.from(String(req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString().split(':').map(decodeURIComponent);
        if (id !== clientId || secret !== clientSecret) return json(401, { error: 'invalid_client' });
        const c = codes.get(p.get('code'));
        codes.delete(p.get('code'));
        if (!c) return json(400, { error: 'invalid_grant' });
        if (crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url') !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
        if (p.get('redirect_uri') !== c.redirect) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri' });
        const now = Math.floor(Date.now() / 1000);
        const { groups, ...profile } = c.user;
        const claims = {
          iss: idp.tamper.iss || idp.issuer, aud: idp.tamper.aud || clientId, sub: c.user.sub, iat: now, exp: idp.tamper.expired ? now - 3600 : now + 300,
          nonce: idp.tamper.nonce || c.nonce, ...profile, ...(idp.groupsInIdToken ? { groups } : {}),
        };
        const access = crypto.randomBytes(16).toString('hex');
        idp.access = { token: access, user: c.user };
        json(200, { access_token: access, token_type: 'Bearer', expires_in: 300, id_token: sign(claims) });
      });
      return;
    }
    if (url.pathname === '/userinfo') {
      if (req.headers.authorization !== `Bearer ${idp.access?.token}`) return json(401, { error: 'invalid_token' });
      return json(200, idp.access.user);
    }
    if (url.pathname === '/end-session') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('signed out at the provider');
    }
    json(404, { error: 'not found' });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    idp.origin = `http://127.0.0.1:${server.address().port}`;
    idp.issuer = `${idp.origin}/application/o/rconsole/`;
    idp.server = server;
    idp.close = () => new Promise((r) => server.close(r));
    resolve(idp);
  }));
}

module.exports = { fakeIdp };

// Standalone for the demo: node test/fake-idp.js --serve [port]. (node --test
// also loads this file; without --serve it only defines the helper.)
if (require.main === module && process.argv.includes('--serve')) {
  fakeIdp({ port: Number(process.argv[process.argv.indexOf('--serve') + 1]) || 8102 }).then((idp) => {
    if (process.env.IDP_GROUPS) idp.user.groups = process.env.IDP_GROUPS.split(',').filter(Boolean);
    console.log(`fake IdP: ${idp.issuer}`);
  });
}

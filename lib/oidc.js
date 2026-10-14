'use strict';

// OpenID Connect sign-in (authorization code flow with PKCE) for one
// identity provider: authentik, Keycloak, Auth0, Pocket ID, Zitadel…
// Standard library only. ID tokens are verified here (RS256, PS256, ES256
// against the provider's published keys); unsigned or HMAC tokens are
// refused.

const crypto = require('crypto');

const ALGS = {
  RS256: (key) => key,
  PS256: (key) => ({ key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }),
  ES256: (key) => ({ key, dsaEncoding: 'ieee-p1363' }),
};
const SKEW_S = 60;
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 200;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const JWKS_REFETCH_MS = 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const fail = (code, message) => Object.assign(new Error(message), { code });
const trimSlash = (s) => String(s).replace(/\/+$/, '');

// http:// only for the local machine (tests, a provider on the same host).
function checkUrl(u, what) {
  const url = new URL(u);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname))) {
    throw fail('config', `${what} must use https: ${u}`);
  }
  return url.toString();
}

// Highest role whose group list shares a group with the user, or null.
function roleFor(groups, map) {
  const have = new Set((Array.isArray(groups) ? groups : [groups]).filter(Boolean).map(String));
  for (const role of ['admin', 'moderator', 'viewer']) if ((map[role] || []).some((g) => have.has(g))) return role;
  return null;
}

class Oidc {
  constructor({ issuer, clientId, clientSecret, redirectUri, postLogoutUri, scopes = 'openid profile email', groupsClaim = 'groups', fetchImpl = globalThis.fetch, now = Date.now }) {
    Object.assign(this, { issuer: checkUrl(issuer, 'OIDC_ISSUER'), clientId, clientSecret, redirectUri, postLogoutUri, scopes, groupsClaim, fetchImpl, now });
    this.meta = null;
    this.metaAt = 0;
    this.jwks = null;
    this.jwksAt = 0;
    this.pending = new Map(); // state -> { nonce, verifier, browser, at }
  }

  async json(url, opts = {}) {
    const res = await this.fetchImpl(url, { ...opts, redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json', ...opts.headers } });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw fail('provider', `${new URL(url).pathname}: not JSON (HTTP ${res.status})`);
    }
    if (!res.ok) throw fail('provider', `${new URL(url).pathname}: HTTP ${res.status}${body.error ? ` ${body.error}${body.error_description ? `: ${body.error_description}` : ''}` : ''}`);
    return body;
  }

  async discover() {
    if (this.meta && this.now() - this.metaAt < DISCOVERY_TTL_MS) return this.meta;
    const meta = await this.json(`${trimSlash(this.issuer)}/.well-known/openid-configuration`);
    if (trimSlash(meta.issuer) !== trimSlash(this.issuer)) throw fail('config', `The provider calls itself ${meta.issuer}, not ${this.issuer}`);
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (!meta[k]) throw fail('config', `The provider's discovery document has no ${k}`);
      checkUrl(meta[k], k);
    }
    if (meta.userinfo_endpoint) checkUrl(meta.userinfo_endpoint, 'userinfo_endpoint');
    this.meta = meta;
    this.metaAt = this.now();
    return meta;
  }

  // The key for `kid`; an unknown kid refetches the set (key rotation), at
  // most once a minute.
  async key(kid, alg) {
    const pick = () => (this.jwks || []).find((k) => (kid ? k.kid === kid : true) && (!k.use || k.use === 'sig') && (!k.alg || k.alg === alg) && (alg === 'ES256' ? k.kty === 'EC' : k.kty === 'RSA'));
    let jwk = pick();
    if (!jwk && this.now() - this.jwksAt > JWKS_REFETCH_MS) {
      const { jwks_uri: uri } = await this.discover();
      this.jwks = (await this.json(uri)).keys || [];
      this.jwksAt = this.now();
      jwk = pick();
    }
    if (!jwk) throw fail('token', `No signing key ${kid || ''} for ${alg}`);
    return crypto.createPublicKey({ key: jwk, format: 'jwk' });
  }

  async verifyIdToken(token, { nonce }) {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw fail('token', 'ID token is not a JWS');
    let header;
    let claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    } catch {
      throw fail('token', 'ID token is not valid JSON');
    }
    if (!ALGS[header.alg]) throw fail('token', `ID token algorithm ${header.alg} is not accepted (use RS256 or ES256: set a signing key on the provider)`);
    const key = await this.key(header.kid, header.alg);
    const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), ALGS[header.alg](key), Buffer.from(parts[2], 'base64url'));
    if (!ok) throw fail('token', 'ID token signature is invalid');

    const meta = await this.discover();
    const t = Math.floor(this.now() / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== meta.issuer) throw fail('token', `ID token issuer ${claims.iss} is not ${meta.issuer}`);
    if (!aud.includes(this.clientId)) throw fail('token', 'ID token is for another client');
    if (aud.length > 1 && claims.azp !== this.clientId) throw fail('token', 'ID token azp is not this client');
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < t) throw fail('token', 'ID token has expired');
    if (typeof claims.iat === 'number' && claims.iat - SKEW_S > t) throw fail('token', 'ID token is from the future');
    if (typeof claims.nbf === 'number' && claims.nbf - SKEW_S > t) throw fail('token', 'ID token is not valid yet');
    if (!nonce || claims.nonce !== nonce) throw fail('token', 'ID token nonce does not match');
    if (!claims.sub) throw fail('token', 'ID token has no subject');
    return claims;
  }

  sweep() {
    for (const [s, p] of this.pending) if (this.now() - p.at > STATE_TTL_MS) this.pending.delete(s);
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value);
  }

  // The provider URL to send the browser to, and a value for a short-lived
  // cookie that ties the answer to this browser (no login CSRF).
  async begin() {
    const meta = await this.discover();
    const state = b64url(crypto.randomBytes(32));
    const nonce = b64url(crypto.randomBytes(32));
    const verifier = b64url(crypto.randomBytes(48));
    const browser = b64url(crypto.randomBytes(32));
    this.sweep();
    this.pending.set(state, { nonce, verifier, browser: sha256(browser), at: this.now() });
    const url = new URL(meta.authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: 'code', client_id: this.clientId, redirect_uri: this.redirectUri, scope: this.scopes,
      state, nonce, code_challenge: b64url(sha256(verifier)), code_challenge_method: 'S256',
    })) url.searchParams.set(k, v);
    return { url: url.toString(), cookie: browser };
  }

  // The provider sent the browser back: check, exchange, verify. Returns the
  // ID token's claims (groups filled in from userinfo when missing).
  async finish({ code, state, cookie, error }) {
    const p = this.pending.get(String(state || ''));
    if (p) this.pending.delete(state); // one use, whatever happens next
    if (!p || this.now() - p.at > STATE_TTL_MS) throw fail('state', 'Unknown or expired sign-in attempt');
    if (!cookie || !crypto.timingSafeEqual(sha256(String(cookie)), p.browser)) throw fail('state', 'Sign-in was started in another browser');
    if (error) throw fail('provider', `The provider refused: ${String(error).slice(0, 100)}`);
    if (!code) throw fail('provider', 'No authorization code');

    const meta = await this.discover();
    const tokens = await this.json(meta.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: String(code), redirect_uri: this.redirectUri, code_verifier: p.verifier }).toString(),
    });
    if (!tokens.id_token) throw fail('provider', 'The provider returned no ID token (is the openid scope allowed?)');
    const claims = await this.verifyIdToken(tokens.id_token, { nonce: p.nonce });
    if (claims[this.groupsClaim] === undefined && meta.userinfo_endpoint && tokens.access_token) {
      const info = await this.json(meta.userinfo_endpoint, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      if (info.sub !== claims.sub) throw fail('token', 'userinfo is for another subject');
      for (const k of [this.groupsClaim, 'preferred_username', 'name', 'email']) if (claims[k] === undefined && info[k] !== undefined) claims[k] = info[k];
    }
    return { claims, idToken: tokens.id_token, groups: [].concat(claims[this.groupsClaim] ?? []).map(String) };
  }

  // Where to send the browser to end the provider session too, if it offers that.
  async logoutUrl(idToken) {
    const meta = await this.discover().catch(() => null);
    if (!meta?.end_session_endpoint) return null;
    const url = new URL(checkUrl(meta.end_session_endpoint, 'end_session_endpoint'));
    if (idToken) url.searchParams.set('id_token_hint', idToken);
    url.searchParams.set('client_id', this.clientId);
    if (this.postLogoutUri) url.searchParams.set('post_logout_redirect_uri', this.postLogoutUri);
    return url.toString();
  }
}

module.exports = { Oidc, roleFor, ALGS };

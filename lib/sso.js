'use strict';

// Single sign-on settings: set in Settings → Account and kept in
// STATE_DIR/sso.json (mode 0600), or in /etc/rconsole.env (OIDC_*,
// LOCAL_LOGIN), which wins field by field and shows as locked in the UI.

const fs = require('fs');
const path = require('path');

const list = (s) => (Array.isArray(s) ? s : String(s || '').split(',')).map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

const DEFAULTS = {
  enabled: false,
  issuer: '',
  clientId: '',
  clientSecret: '',
  name: 'SSO',
  scopes: 'openid profile email',
  groupsClaim: 'groups',
  groups: { admin: ['rconsole-admins'], moderator: ['rconsole-moderators'], viewer: ['rconsole-viewers'] },
  sessionHours: 12,
  localLogin: true,
};

class SsoSettings {
  constructor({ stateDir, env = process.env, envConfig }) {
    this.file = path.join(stateDir, 'sso.json');
    this.env = envConfig; // config.oidc + localLogin, as read from the environment
    const has = (k) => env[k] !== undefined && env[k] !== '';
    this.fromEnv = {
      issuer: has('OIDC_ISSUER'),
      clientId: has('OIDC_CLIENT_ID'),
      clientSecret: has('OIDC_CLIENT_SECRET') || has('OIDC_CLIENT_SECRET_FILE'),
      name: has('OIDC_NAME'),
      scopes: has('OIDC_SCOPES'),
      groupsClaim: has('OIDC_GROUPS_CLAIM'),
      admin: has('OIDC_ADMIN_GROUPS'),
      moderator: has('OIDC_MODERATOR_GROUPS'),
      viewer: has('OIDC_VIEWER_GROUPS'),
      sessionHours: has('OIDC_SESSION_HOURS'),
      localLogin: has('LOCAL_LOGIN'),
    };
    this.saved = this.read();
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  // What applies: environment first, then the saved settings, then defaults.
  get(saved = this.saved) {
    const s = { ...DEFAULTS, ...saved, groups: { ...DEFAULTS.groups, ...(saved.groups || {}) } };
    const e = this.env;
    const f = this.fromEnv;
    for (const k of ['issuer', 'clientId', 'clientSecret', 'name', 'scopes', 'groupsClaim', 'sessionHours']) if (f[k]) s[k] = e.oidc[k];
    for (const r of ['admin', 'moderator', 'viewer']) if (f[r]) s.groups[r] = e.oidc.groups[r];
    if (f.localLogin) s.localLogin = e.localLogin;
    if (f.issuer) s.enabled = true; // configured on the server: on
    if (!s.enabled) s.localLogin = true; // never lock everyone out
    return s;
  }

  // The settings for the form: no secret, plus which fields are locked.
  view() {
    const s = this.get();
    const { clientSecret, ...rest } = s;
    return { ...rest, hasSecret: Boolean(clientSecret), fromEnv: this.fromEnv };
  }

  // Validates and returns the next settings without saving them.
  next(input) {
    const cur = { ...DEFAULTS, ...this.saved, groups: { ...DEFAULTS.groups, ...(this.saved.groups || {}) } };
    const n = { ...cur, groups: { ...cur.groups } };
    if (input.enabled !== undefined) n.enabled = Boolean(input.enabled);
    if (input.issuer !== undefined) {
      const u = String(input.issuer).trim();
      if (u && !/^https:\/\/[^\s?#]+$/.test(u) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)) throw bad('Issuer must be an https:// URL, e.g. https://auth.example.com/application/o/rconsole/');
      n.issuer = u;
    }
    if (input.clientId !== undefined) n.clientId = String(input.clientId).trim().slice(0, 200);
    if (input.clientSecret) n.clientSecret = String(input.clientSecret).trim().slice(0, 500); // empty keeps the saved one
    if (input.name !== undefined) n.name = String(input.name).trim().slice(0, 40) || 'SSO';
    for (const r of ['admin', 'moderator', 'viewer']) if (input.groups?.[r] !== undefined) n.groups[r] = list(input.groups[r]);
    if (input.sessionHours !== undefined) {
      const h = Number(input.sessionHours);
      if (!(h >= 1 && h <= 168)) throw bad('Sessions: between 1 and 168 hours');
      n.sessionHours = h;
    }
    if (input.localLogin !== undefined) n.localLogin = Boolean(input.localLogin);
    if (n.enabled) {
      const s = { ...n, ...Object.fromEntries(['issuer', 'clientId', 'clientSecret'].filter((k) => this.fromEnv[k]).map((k) => [k, this.env.oidc[k]])) };
      if (!s.issuer) throw bad('Enter the issuer URL from your provider');
      if (!s.clientId) throw bad('Enter the client ID');
      if (!s.clientSecret) throw bad('Enter the client secret');
      if (!Object.values(n.groups).some((g) => g.length)) throw bad('Name at least one group, or nobody can sign in');
    } else n.localLogin = true;
    return n;
  }

  save(n) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(n, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.saved = n;
  }
}

module.exports = { SsoSettings, DEFAULTS };

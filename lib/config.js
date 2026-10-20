'use strict';

const fs = require('fs');
const path = require('path');

const env = process.env;

// systemd sets STATE_DIRECTORY when the unit has StateDirectory=; the CLI
// falls back to the same /var/lib/rconsole the service uses.
function stateDir() {
  if (env.STATE_DIRECTORY) return path.resolve(env.STATE_DIRECTORY.split(':')[0]);
  if (env.STATE_DIR) return path.resolve(env.STATE_DIR);
  if (fs.existsSync('/var/lib/rconsole')) return '/var/lib/rconsole';
  return path.join(__dirname, '..', 'data');
}

const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// A secret from VAR, or from the file VAR_FILE names (systemd credentials, Docker secrets).
function secret(name) {
  if (env[name]) return env[name];
  if (env[`${name}_FILE`]) {
    try {
      return fs.readFileSync(env[`${name}_FILE`], 'utf8').trim();
    } catch {}
  }
  return '';
}

// WEB_*, TRUST_PROXY, REQUIRE_2FA and the others in lib/system.js: what
// Settings → System saved (STATE_DIR/system.json) wins over the env file.
const sys = require('./system').effective(env, require('./system').readSaved(stateDir()));
const require2fa = (mode) => ({ admin: ['admin'], all: ['admin', 'moderator', 'viewer'] })[mode] || [];

module.exports = {
  rconHost: env.RCON_HOST || '127.0.0.1',
  rconPort: Number(env.RCON_PORT) || 25575,
  rconPassword: env.RCON_PASSWORD,
  webHost: sys.webHost,
  webPort: sys.webPort,
  // Only requests from these addresses may set X-Forwarded-For / -Proto.
  trustProxy: sys.trustProxy,
  mcDir: path.resolve(env.MC_DIR || '/srv/minecraft'),
  mcJar: env.MC_JAR || 'paper.jar',
  mcService: env.MC_SERVICE || 'minecraft.service',
  // Servers rconsole installs itself, one folder per instance (lib/instances.js).
  serversDir: path.resolve(env.SERVERS_DIR || '/srv/minecraft-servers'),
  // systemd: start rconsole-<kind>@ units (production). direct: run the helper
  // in-process as the current user (development, or when rconsole runs as the
  // Minecraft user).
  jobRunner: env.JOB_RUNNER === 'direct' ? 'direct' : 'systemd',
  backupDir: path.resolve(env.BACKUP_DIR || '/srv/minecraft-backups'),
  backupKeep: sys.backupKeep,
  // auto: zstd when installed; gzip: .tar.gz.
  backupCompression: sys.backupCompression,
  updateCheck: sys.updateCheck,
  stateDir: stateDir(),
  // Optional integrations.
  metricsToken: sys.metricsToken,
  mapUrl: (env.MAP_URL || '').replace(/\/+$/, ''),
  publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
  // Single sign-on with an OpenID Connect provider (authentik, Keycloak, Auth0…).
  oidc: {
    issuer: env.OIDC_ISSUER || '',
    clientId: env.OIDC_CLIENT_ID || '',
    clientSecret: secret('OIDC_CLIENT_SECRET'),
    name: env.OIDC_NAME || 'SSO',
    scopes: env.OIDC_SCOPES || 'openid profile email',
    groupsClaim: env.OIDC_GROUPS_CLAIM || 'groups',
    groups: {
      admin: list(env.OIDC_ADMIN_GROUPS ?? 'rconsole-admins'),
      moderator: list(env.OIDC_MODERATOR_GROUPS ?? 'rconsole-moderators'),
      viewer: list(env.OIDC_VIEWER_GROUPS ?? 'rconsole-viewers'),
    },
    sessionHours: Number(env.OIDC_SESSION_HOURS) > 0 ? Number(env.OIDC_SESSION_HOURS) : 12,
  },
  // Roles whose local accounts must use 2FA: REQUIRE_2FA=admin (admins),
  // all (everyone) or off (default).
  require2faMode: sys.require2fa,
  require2fa: require2fa(sys.require2fa),
  require2faRoles: require2fa,
  // Username and password sign-in; keep it as a fallback for when the provider is down.
  localLogin: !/^(off|false|0|no)$/i.test(env.LOCAL_LOGIN || ''),
};

#!/usr/bin/env node
'use strict';

// User management: node cli.js user <add|passwd|remove|list|role|access|totp|totp-off|link|unlink> [name]
// Settings → System from the shell: node cli.js system <show|reset> [setting]

const readline = require('readline');
const config = require('./lib/config');
const { Users, newTotpSecret, totpUri, verifyTotp, newRecoveryCodes, ROLES, ATTACHED } = require('./lib/auth');

// --role admin|moderator|viewer for `user add`
const roleFlag = () => {
  const i = process.argv.indexOf('--role');
  if (i < 0) return null;
  const role = process.argv[i + 1];
  if (!ROLES.includes(role)) throw new Error(`--role must be one of: ${ROLES.join(', ')}`);
  return role;
};

const users = new Users(config.stateDir);

// One reader for the whole run, so piped input isn't lost between prompts.
let rl, lines, muted = false;

async function ask(question, { hidden = false } = {}) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    rl._writeToOutput = (s) => muted || rl.output.write(s); // hides typed passwords
    lines = rl[Symbol.asyncIterator]();
  }
  process.stdout.write(question);
  muted = hidden;
  const { value, done } = await lines.next();
  muted = false;
  if (hidden) process.stdout.write('\n');
  if (done) throw new Error('No input');
  return value;
}

async function newPassword() {
  const pw = await ask('Password (min 10 chars): ', { hidden: true });
  const again = await ask('Repeat password: ', { hidden: true });
  if (pw !== again) throw new Error('Passwords do not match');
  return pw;
}

function need(name) {
  if (!name) throw new Error('Missing username');
  return name.toLowerCase();
}

const commands = {
  async add(name) {
    name = need(name);
    if (users.get(name)) throw new Error(`User ${name} already exists (use passwd)`);
    const role = roleFlag();
    await users.setPassword(name, await newPassword());
    if (role) users.setRole(name, role);
    console.log(`Created user ${name} (${users.roleOf(name)}).`);
  },
  async passwd(name) {
    name = need(name);
    if (!users.get(name)) throw new Error(`No such user: ${name}`);
    await users.setPassword(name, await newPassword());
    console.log(`Password changed. Existing sessions of ${name} are signed out.`);
  },
  async remove(name) {
    users.remove(need(name));
    console.log(`Removed ${name}.`);
  },
  async list() {
    const all = users.load();
    const names = Object.keys(all);
    if (!names.length) return console.log('No users. Create one with: user add <name>');
    for (const n of names) {
      const u = all[n];
      const how = u.sso ? `SSO ${u.sso.email || u.sso.name || u.sso.sub}`.slice(0, 40) : `local, 2FA ${u.totp ? 'on' : 'off'}`;
      console.log(`${n.padEnd(20)} ${users.roleOf(n).padEnd(10)} ${how.padEnd(42)} ${u.sso ? `last sign-in ${u.lastLogin || '–'}` : `created ${u.created}`}`);
      if (u.servers) console.log(`${''.padEnd(20)} ${Object.entries(u.servers).map(([k, r]) => `${k === ATTACHED ? 'attached' : k}: ${r === 'none' ? 'no access' : r}`).join(', ')}`);
    }
    if (names.some((n) => all[n].sso)) console.log('\nSSO accounts get their role from the provider\'s groups at each sign-in; removing one only lasts until their next sign-in.');
  },
  async totp(name) {
    name = need(name);
    if (!users.get(name)) throw new Error(`No such user: ${name}`);
    if (users.get(name).sso) throw new Error(`${name} signs in through single sign-on; set up 2FA at the provider`);
    const secret = newTotpSecret();
    console.log('\nAdd this to your authenticator app (1Password, Aegis, Google Authenticator, …):\n');
    console.log(`  Secret: ${secret.match(/.{1,4}/g).join(' ')}`);
    console.log(`  URI:    ${totpUri(name, secret)}\n`);
    const code = (await ask('Enter the 6-digit code to confirm: ')).trim();
    if (verifyTotp(secret, code) === null) throw new Error('Code did not match, 2FA not enabled');
    const recovery = newRecoveryCodes();
    users.setTotp(name, secret, recovery);
    console.log(`2FA enabled for ${name}.\n`);
    console.log('Recovery codes: each signs in once in place of the 6-digit code, if the phone is lost.');
    console.log('Keep them somewhere safe; they are not shown again (run user totp again for new ones).\n');
    for (let i = 0; i < recovery.length; i += 2) console.log(`  ${recovery[i]}   ${recovery[i + 1] || ''}`);
    console.log('');
  },
  async role(name) {
    name = need(name);
    const role = process.argv[5];
    if (!role) return console.log(`${name} is ${users.roleOf(name)}. Change with: user role ${name} <${ROLES.join('|')}>`);
    users.setRole(name, role);
    console.log(`${name} is now ${role}. Their sessions were signed out.`);
    if (users.get(name)?.sso) console.log('Note: this is an SSO account; its next sign-in sets the role from the provider\'s groups again.');
  },
  // Role on one server, or no access to it: user access <name> <server> <role|none|default>.
  // <server> is a server id (Servers page), or "attached" for the server in MC_DIR.
  async access(name) {
    name = need(name);
    if (!users.get(name)) throw new Error(`No such user: ${name}`);
    const [server, role] = process.argv.slice(5);
    const key = server === 'attached' ? ATTACHED : server;
    if (!server) {
      const map = users.get(name).servers || {};
      console.log(`${name}: ${users.roleOf(name)} on every server${Object.keys(map).length ? ', except:' : '.'}`);
      for (const [k, r] of Object.entries(map)) console.log(`  ${(k === ATTACHED ? 'attached' : k).padEnd(20)} ${r === 'none' ? 'no access' : r}`);
      return console.log(`Change with: user access ${name} <server|attached> <${ROLES.join('|')}|none|default>`);
    }
    if (!role) throw new Error(`Usage: user access ${name} ${server} <${ROLES.join('|')}|none|default>`);
    users.setServerRole(name, key, role === 'default' ? null : role);
    console.log(role === 'default' ? `${name} has their account's role (${users.roleOf(name)}) on ${server} again.` : `${name} is now ${role === 'none' ? 'without access to' : `${role} on`} ${server}.`);
  },
  // Ties a local account to the provider user of an SSO account and removes
  // that SSO account: for when someone signed in with the provider before
  // linking, and got "name-2".
  async link(name) {
    name = need(name);
    const from = process.argv[5]?.toLowerCase();
    if (!from) throw new Error('Usage: user link <local account> <SSO account to merge into it>');
    const local = users.get(name);
    const other = users.get(from);
    if (!local) throw new Error(`No such user: ${name}`);
    if (!other?.sso) throw new Error(`${from} is not an SSO account (node cli.js user list shows them)`);
    if (local.sso) throw new Error(`${name} is already an SSO account`);
    const { iss, sub, name: display, email } = other.sso;
    users.linkSso(name, { iss, sub, name: display, email, role: users.roleOf(from) });
    console.log(`${name} now signs in with single sign-on as ${display || email || sub}; ${from} was merged into it and removed.`);
    console.log(`Its password and 2FA were removed and its sessions signed out. Its role (${users.roleOf(name)}) follows the provider's groups from the next sign-in.`);
  },
  async unlink(name) {
    name = need(name);
    users.unlinkSso(name);
    console.log(`${name} no longer signs in with single sign-on. Give it a password with: node cli.js user passwd ${name}`);
  },
  async 'totp-off'(name) {
    users.setTotp(need(name), null);
    console.log(`2FA disabled for ${name}.`);
  },
};

// What Settings → System saved, and a way back to /etc/rconsole.env when a
// saved value locks you out (restart rconsole afterwards).
const system = {
  show() {
    const sys = new (require('./lib/system').SystemSettings)({ stateDir: config.stateDir });
    const view = sys.view();
    for (const [k, v] of Object.entries(view)) {
      const value = 'set' in v ? (v.set ? 'set' : 'off') : JSON.stringify(v.value);
      console.log(`${k.padEnd(18)} ${value.padEnd(24)} ${v.source === 'saved' ? `saved in Settings (overrides ${v.env})` : v.source === 'env' ? `from ${v.env}` : 'default'}`);
    }
  },
  reset(key) {
    const { SystemSettings, FIELDS } = require('./lib/system');
    const sys = new SystemSettings({ stateDir: config.stateDir });
    if (key && !FIELDS[key]) throw new Error(`No such setting: ${key} (one of ${Object.keys(FIELDS).join(', ')})`);
    const keys = key ? [key] : Object.keys(sys.saved);
    if (!keys.length) return console.log('Nothing saved in Settings → System; /etc/rconsole.env applies.');
    sys.save(sys.next({ reset: keys }).saved);
    console.log(`Reset ${keys.join(', ')}: /etc/rconsole.env applies again after: sudo systemctl restart rconsole`);
  },
};

async function main() {
  const [group, cmd, name] = process.argv.slice(2);
  if (group === 'system' && system[cmd]) return system[cmd](name);
  if (group !== 'user' || !commands[cmd]) {
    console.log(`Usage: node cli.js user <${Object.keys(commands).join('|')}> [name]`);
    console.log('       node cli.js user add <name> [--role admin|moderator|viewer]');
    console.log('       node cli.js user role <name> [admin|moderator|viewer]');
    console.log('       node cli.js user link <local account> <SSO account to merge into it>');
    console.log('       node cli.js system show | system reset [setting]');
    console.log(`State directory: ${config.stateDir}`);
    process.exit(group ? 1 : 0);
  }
  await commands[cmd](name);
}

main()
  .catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => rl?.close());

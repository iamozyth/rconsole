#!/usr/bin/env node
'use strict';

// User management: node cli.js user <add|passwd|remove|list|totp|totp-off> [name]

const readline = require('readline');
const config = require('./lib/config');
const { Users, newTotpSecret, totpUri, verifyTotp } = require('./lib/auth');

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
    await users.setPassword(name, await newPassword());
    console.log(`Created user ${name}.`);
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
    for (const n of names) console.log(`${n.padEnd(20)} 2FA: ${all[n].totp ? 'on ' : 'off'}  created ${all[n].created}`);
  },
  async totp(name) {
    name = need(name);
    if (!users.get(name)) throw new Error(`No such user: ${name}`);
    const secret = newTotpSecret();
    console.log('\nAdd this to your authenticator app (1Password, Aegis, Google Authenticator, …):\n');
    console.log(`  Secret: ${secret.match(/.{1,4}/g).join(' ')}`);
    console.log(`  URI:    ${totpUri(name, secret)}\n`);
    const code = (await ask('Enter the 6-digit code to confirm: ')).trim();
    if (verifyTotp(secret, code) === null) throw new Error('Code did not match, 2FA not enabled');
    users.setTotp(name, secret);
    console.log(`2FA enabled for ${name}.`);
  },
  async 'totp-off'(name) {
    users.setTotp(need(name), null);
    console.log(`2FA disabled for ${name}.`);
  },
};

async function main() {
  const [group, cmd, name] = process.argv.slice(2);
  if (group !== 'user' || !commands[cmd]) {
    console.log(`Usage: node cli.js user <${Object.keys(commands).join('|')}> [name]`);
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

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readGitHead } = require('../lib/selfupdate');

test('readGitHead reads loose refs, packed refs and detached heads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-git-'));
  const git = path.join(dir, '.git');
  const sha = 'a'.repeat(40);
  fs.mkdirSync(path.join(git, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(git, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(git, 'refs', 'heads', 'main'), `${sha}\n`);
  assert.deepStrictEqual(readGitHead(dir), { sha, branch: 'main' });
  fs.rmSync(path.join(git, 'refs', 'heads', 'main'));
  fs.writeFileSync(path.join(git, 'packed-refs'), `# pack-refs\n${'b'.repeat(40)} refs/heads/main\n`);
  assert.deepStrictEqual(readGitHead(dir), { sha: 'b'.repeat(40), branch: 'main' });
  fs.writeFileSync(path.join(git, 'HEAD'), `${'c'.repeat(40)}\n`);
  assert.deepStrictEqual(readGitHead(dir), { sha: 'c'.repeat(40), branch: null });
  assert.strictEqual(readGitHead(os.tmpdir() + '/nope'), null);
});

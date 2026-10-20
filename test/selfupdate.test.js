'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readGitHead, commitEntry, SelfUpdate } = require('../lib/selfupdate');

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

test('commitEntry: title, release version and the description without trailers', () => {
  const e = commitEntry({ sha: 'abcdef0123456789', commit: { committer: { date: '2026-10-20T10:00:00Z' }, message: '4.10.1: open owner-only files (#23)\n\nPlugins save configs as 0600.\nReads now fall back.\n\n\nClaude-Session: https://x\n\nCo-authored-by: Claude <n@a>\n---------\nSigned-off-by: a <b>' } });
  assert.deepStrictEqual(e, { sha: 'abcdef0', message: '4.10.1: open owner-only files (#23)', version: '4.10.1', body: 'Plugins save configs as 0600.\nReads now fall back.', date: '2026-10-20T10:00:00Z' });
  assert.strictEqual(commitEntry({ sha: 'a'.repeat(40), commit: { message: 'Fix CI' } }).version, null);
});

test('overview: a finished update lists what it brought in, asked once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rconsole-su-'));
  const from = 'a'.repeat(40), to = 'b'.repeat(40);
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `${to}\n`);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"9.1.0"}');
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ state: 'done', from, to, at: new Date().toISOString(), steps: [] }));
  process.env.SELF_UPDATE_STATUS = path.join(dir, 'status.json');
  const su = new SelfUpdate({ dir, stateDir: dir, runner: 'direct' });
  delete process.env.SELF_UPDATE_STATUS;
  const urls = [];
  su.fetchJson = async (url) => {
    urls.push(url);
    return { status: 'identical', ahead_by: 0, commits: [{ sha: to, commit: { message: '9.1.0: things' } }] };
  };
  const o = await su.overview();
  assert.strictEqual(o.current.version, '9.1.0');
  assert.deepStrictEqual(o.update.commits.map((c) => c.version), ['9.1.0']);
  await su.overview();
  assert.strictEqual(urls.filter((u) => u.includes(`${from}...${to}`)).length, 1);
});

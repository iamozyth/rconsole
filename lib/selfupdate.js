'use strict';

// rconsole's own updates: which commit is installed (read from .git without
// running git), what is new on GitHub (compare API, so the UI can show the
// changelog), and starting rconsole-selfupdate.service, which does the actual
// update as root.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = process.env.RCONSOLE_REPO || 'iamozyth/rconsole';
const BRANCH = process.env.RCONSOLE_BRANCH || 'main';
const API = process.env.GITHUB_API || 'https://api.github.com';
const UNIT = 'rconsole-selfupdate.service';
const CHECK_MS = 6 * 60 * 60 * 1000;
const SHA_RE = /^[a-f0-9]{40}$/;
// bin/self-update.sh then installs signed release tags only, so "new" means
// a newer release, not a newer commit on the branch.
const SIGNED = Boolean(process.env.SELF_UPDATE_SIGNERS);
// How long a finished update keeps its steps and changes on Server → Updates.
const RECENT_MS = 60 * 60 * 1000;

// A commit as the UI lists it: title, the version it releases ("4.10.1: …"
// is how release commits are titled) and its description without the
// trailers git and GitHub add (co-authors, sign-offs, squash separators).
function commitEntry(c) {
  const lines = String(c.commit?.message || '').split('\n');
  const title = lines[0].slice(0, 200);
  const body = lines.slice(1)
    .filter((l) => !/^\s*([A-Za-z-]+-by|Claude-Session|Change-Id):/i.test(l) && !/^-{3,}\s*$/.test(l))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    sha: c.sha.slice(0, 7),
    message: title,
    version: title.match(/^v?(\d+\.\d+\.\d+)\b/)?.[1] || null,
    body: body.length > 2000 ? `${body.slice(0, 2000)}…` : body,
    date: c.commit?.committer?.date || c.commit?.author?.date || null,
  };
}

function readGitHead(dir) {
  const git = path.join(dir, '.git');
  try {
    const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
    if (SHA_RE.test(head)) return { sha: head, branch: null };
    const ref = head.match(/^ref: (refs\/heads\/(.+))$/);
    if (!ref) return null;
    let sha = null;
    try {
      sha = fs.readFileSync(path.join(git, ref[1]), 'utf8').trim();
    } catch {
      const packed = fs.readFileSync(path.join(git, 'packed-refs'), 'utf8');
      sha = packed.split('\n').find((l) => l.endsWith(` ${ref[1]}`))?.split(' ')[0] || null;
    }
    return SHA_RE.test(sha || '') ? { sha, branch: ref[2] } : null;
  } catch {
    return null;
  }
}

class SelfUpdate {
  constructor({ dir, stateDir, runner, log = () => {} }) {
    Object.assign(this, { dir, runner, log });
    // Written by root (bin/self-update.sh) into its own directory; older
    // versions wrote into rconsole's state dir, read as a fallback.
    this.statusFiles = [process.env.SELF_UPDATE_STATUS || '/var/lib/rconsole-selfupdate/self-update.json', path.join(stateDir, 'self-update.json')];
    this.check = null; // last check result
    this.checking = null;
    this.changes = null; // { key, commits } of the last finished update
  }

  installed() {
    return readGitHead(this.dir);
  }

  version() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, 'package.json'), 'utf8')).version || null;
    } catch {
      return null;
    }
  }

  // The Node.js this version needs (engines.node) and the one it runs on.
  // Older: the next update installs it (bin/self-update.sh), even when
  // there are no new commits.
  node() {
    let need = 0;
    try {
      need = Number(JSON.parse(fs.readFileSync(path.join(this.dir, 'package.json'), 'utf8')).engines.node.match(/\d+/)[0]);
    } catch {}
    return { version: process.version, need, ok: Number(process.versions.node.split('.')[0]) >= need };
  }

  status() {
    const all = this.statusFiles.map((f) => {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        return null;
      }
    }).filter(Boolean);
    return all.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
  }

  async fetchJson(url) {
    const res = await fetch(url, { headers: { 'User-Agent': 'iamozyth/rconsole', Accept: 'application/vnd.github+json' } });
    if (res.status === 404) return null;
    if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit reached; try again later');
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    return res.json();
  }

  async runCheck() {
    const local = this.installed();
    if (!local) {
      this.check = { at: new Date().toISOString(), error: 'Not a git checkout, so rconsole can’t update itself. Install it with git clone (see README).' };
      return this.check;
    }
    try {
      const target = SIGNED ? (await this.fetchJson(`${API}/repos/${REPO}/releases/latest`))?.tag_name : BRANCH;
      if (!target) throw new Error(`No release of ${REPO} found`);
      const cmp = await this.fetchJson(`${API}/repos/${REPO}/compare/${local.sha}...${encodeURIComponent(target)}`);
      if (!cmp) {
        this.check = { at: new Date().toISOString(), error: `Commit ${local.sha.slice(0, 7)} isn’t on GitHub (${REPO}); local changes?` };
        return this.check;
      }
      const commits = (cmp.commits || []).slice(-30).reverse().map(commitEntry);
      this.check = {
        sha: local.sha,
        at: new Date().toISOString(),
        status: cmp.status, // ahead | identical | behind | diverged
        behind: cmp.ahead_by || 0,
        localDate: cmp.base_commit?.commit?.committer?.date || null,
        latest: commits[0] || null,
        version: commits.find((c) => c.version)?.version || null,
        commits,
        error: null,
      };
    } catch (err) {
      this.check = { ...(this.check || {}), at: new Date().toISOString(), error: err.message };
    }
    return this.check;
  }

  async overview({ refresh = false } = {}) {
    if (refresh || !this.check || Date.now() - Date.parse(this.check.at) > CHECK_MS) {
      this.checking ??= this.runCheck().finally(() => (this.checking = null));
      await this.checking;
    }
    const local = this.installed();
    // A check from before rconsole moved to another commit (an update ran
    // by hand, say) describes the wrong range.
    if (local && this.check?.sha && this.check.sha !== local.sha && !this.checking) {
      this.checking ??= this.runCheck().finally(() => (this.checking = null));
      await this.checking;
    }
    const update = this.status();
    if (update) update.commits = await this.updateChanges(update);
    return { repo: REPO, branch: BRANCH, signedReleases: SIGNED, current: local ? { sha: local.sha.slice(0, 7), branch: local.branch, version: this.version() } : null, check: this.check, update, node: this.node(), canUpdate: this.runner !== 'direct' && Boolean(local) };
  }

  // What the last update brought in, for its "done" card: the restart
  // dropped the check from before, so ask GitHub once per update.
  async updateChanges(u) {
    if (u.state !== 'done' || !SHA_RE.test(u.from || '') || !SHA_RE.test(u.to || '') || u.from === u.to) return null;
    if (Date.now() - Date.parse(u.at) > RECENT_MS) return null;
    const key = `${u.from}...${u.to}`;
    if (this.changes?.key !== key) {
      this.changes = { key, commits: null };
      try {
        const cmp = await this.fetchJson(`${API}/repos/${REPO}/compare/${key}`);
        this.changes.commits = (cmp?.commits || []).slice(-30).reverse().map(commitEntry);
      } catch {
        this.changes = null; // try again next time
        return null;
      }
    }
    return this.changes.commits;
  }

  // Short form for /api/status.
  summary() {
    const local = this.installed();
    const st = this.status();
    return {
      current: local?.sha.slice(0, 7) || null,
      available: this.check?.status === 'ahead' ? this.check.behind : 0,
      running: st?.state === 'running' && Date.now() - Date.parse(st.at) < 20 * 60 * 1000, // apt may take long (TimeoutStartSec)
    };
  }

  start() {
    if (this.runner === 'direct') throw Object.assign(new Error('Self-update needs the systemd units (JOB_RUNNER=direct is for development)'), { status: 409 });
    if (!this.installed()) throw Object.assign(new Error('Not a git checkout'), { status: 409 });
    if (this.summary().running) throw Object.assign(new Error('An update is already running'), { status: 409 });
    return new Promise((resolve, reject) => {
      // --no-block: the updater restarts rconsole, so don't wait for it.
      const child = spawn('systemctl', ['start', '--no-block', UNIT], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => reject(e));
      child.on('close', (code) => {
        if (code === 0) {
          this.log('self-update: started');
          return resolve({ started: true });
        }
        if (/not found|could not be found/i.test(err)) return reject(Object.assign(new Error(`${UNIT} isn't installed yet. See "Updating" in the README for the one-time setup.`), { status: 409 }));
        if (/interactive authentication|access denied|not authorized/i.test(err)) return reject(Object.assign(new Error('Not allowed to start the updater. Install the current polkit rule (see README).'), { status: 403 }));
        reject(new Error(err.trim() || `systemctl exited with ${code}`));
      });
    });
  }

  // enabled(): Settings → System → check for updates (SELF_UPDATE_CHECK).
  startTimer(enabled = () => process.env.SELF_UPDATE_CHECK !== '0') {
    const tick = () => enabled() && this.overview().catch(() => {});
    setTimeout(tick, 30 * 1000).unref();
    setInterval(tick, CHECK_MS).unref();
  }
}

module.exports = { SelfUpdate, readGitHead, commitEntry };

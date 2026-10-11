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
    this.statusFile = path.join(stateDir, 'self-update.json');
    this.check = null; // last check result
    this.checking = null;
    this.startedAt = null;
  }

  installed() {
    return readGitHead(this.dir);
  }

  status() {
    try {
      return JSON.parse(fs.readFileSync(this.statusFile, 'utf8'));
    } catch {
      return null;
    }
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
      const cmp = await this.fetchJson(`${API}/repos/${REPO}/compare/${local.sha}...${encodeURIComponent(BRANCH)}`);
      if (!cmp) {
        this.check = { at: new Date().toISOString(), error: `Commit ${local.sha.slice(0, 7)} isn’t on GitHub (${REPO}); local changes?` };
        return this.check;
      }
      const commits = (cmp.commits || []).slice(-30).reverse().map((c) => ({
        sha: c.sha.slice(0, 7),
        message: String(c.commit?.message || '').split('\n')[0].slice(0, 200),
        date: c.commit?.committer?.date || c.commit?.author?.date || null,
      }));
      this.check = {
        at: new Date().toISOString(),
        status: cmp.status, // ahead | identical | behind | diverged
        behind: cmp.ahead_by || 0,
        localDate: cmp.base_commit?.commit?.committer?.date || null,
        latest: commits[0] || null,
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
    return { repo: REPO, branch: BRANCH, current: local ? { sha: local.sha.slice(0, 7), branch: local.branch } : null, check: this.check, update: this.status(), canUpdate: this.runner !== 'direct' && Boolean(local) };
  }

  // Short form for /api/status.
  summary() {
    const local = this.installed();
    const st = this.status();
    return {
      current: local?.sha.slice(0, 7) || null,
      available: this.check?.status === 'ahead' ? this.check.behind : 0,
      running: st?.state === 'running' && Date.now() - Date.parse(st.at) < 10 * 60 * 1000,
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

  startTimer() {
    if (process.env.SELF_UPDATE_CHECK === '0') return;
    const tick = () => this.overview().catch(() => {});
    setTimeout(tick, 30 * 1000).unref();
    setInterval(tick, CHECK_MS).unref();
  }
}

module.exports = { SelfUpdate, readGitHead };

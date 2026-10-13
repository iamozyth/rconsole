'use strict';

// Discord webhooks: alerts as embeds (same events, priorities and quiet hours
// as ntfy), and an optional relay of chat, joins and leaves into a channel,
// batched to stay well under Discord's rate limits. Mentions are disabled,
// so nobody in Minecraft can ping @everyone through the relay.

const { parseLine } = require('./logfiles');

const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d{5,30}\/[A-Za-z0-9_-]{20,100}$/;
const COLORS = { 5: 0xef4444, 4: 0xf59e0b, 3: 0xa78bfa, 2: 0x737373, 1: 0x737373 };
const BATCH_MS = 2500;
const MAX_CONTENT = 1900;

const isWebhook = (url) => WEBHOOK_RE.test(String(url || ''));
// Keeps Discord markdown from mangling player text.
const escape = (s) => String(s).replace(/([\\*_~`|>#-])/g, '\\$1').replace(/@/g, '@\u200b');

// A chat-relay line for a log line, or null.
function relayLine(line) {
  const p = parseLine(line);
  if (!p) return null;
  const body = p.msg.replace(/^System chat: /, '');
  let m;
  if ((m = p.msg.match(/^(?:\[Not Secure\] )?<([^>]{1,48})> (.*)$/))) return `**${escape(m[1])}**: ${escape(m[2])}`;
  if ((m = body.match(/^\[Web\] ([^:]{1,32}): (.*)$/))) return `**${escape(m[1])}** (web): ${escape(m[2])}`;
  if ((m = body.match(/^\[Server\] (.*)$/))) return `📢 ${escape(m[1])}`;
  if ((m = body.match(/^([A-Za-z0-9_]{1,16}) joined the game$/))) return `➡️ **${escape(m[1])}** joined`;
  if ((m = body.match(/^([A-Za-z0-9_]{1,16}) left the game$/))) return `⬅️ **${escape(m[1])}** left`;
  return null;
}

class Discord {
  constructor({ log = () => {}, fetchImpl = (...a) => fetch(...a) } = {}) {
    Object.assign(this, { log, fetch: fetchImpl });
    this.queue = [];
    this.timer = null;
    this.retryAfter = 0;
  }

  async post(url, payload) {
    if (Date.now() < this.retryAfter) throw new Error('Discord rate limit, try again shortly');
    const res = await this.fetch(`${url}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'rconsole', allowed_mentions: { parse: [] }, ...payload }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429) {
      const wait = Number((await res.json().catch(() => ({}))).retry_after) || 5;
      this.retryAfter = Date.now() + wait * 1000;
      throw new Error(`Discord rate limit (${wait}s)`);
    }
    if (!res.ok) throw new Error(`Discord answered ${res.status}${res.status === 404 ? ' (webhook deleted?)' : ''}`);
    return true;
  }

  // One alert as an embed.
  alert(url, { title, message, priority = 3, link, icon }) {
    return this.post(url, {
      ...(icon ? { avatar_url: icon } : {}),
      embeds: [{
        title: String(title).slice(0, 250),
        description: String(message || '').slice(0, 3500) || undefined,
        color: COLORS[priority] ?? COLORS[3],
        ...(link ? { url: link } : {}),
        timestamp: new Date().toISOString(),
        footer: { text: 'rconsole' },
      }],
    });
  }

  // Chat relay: collect lines and send them together.
  relay(url, line, icon) {
    const text = relayLine(line);
    if (!text) return false;
    this.queue.push(text);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(url, icon), BATCH_MS);
      this.timer.unref?.();
    }
    return true;
  }

  async flush(url, icon) {
    this.timer = null;
    if (!this.queue.length) return;
    let content = '';
    while (this.queue.length && content.length + this.queue[0].length + 1 <= MAX_CONTENT) content += `${this.queue.shift()}\n`;
    if (!content) content = `${this.queue.shift().slice(0, MAX_CONTENT)}\n`;
    try {
      await this.post(url, { content, ...(icon ? { avatar_url: icon } : {}) });
    } catch (err) {
      this.log(`discord: ${err.message}`);
      if (/rate limit/.test(err.message)) this.queue.unshift(...content.trimEnd().split('\n'));
    }
    if (this.queue.length > 200) this.queue.splice(0, this.queue.length - 200);
    if (this.queue.length) {
      this.timer = setTimeout(() => this.flush(url, icon), Math.max(BATCH_MS, this.retryAfter - Date.now()));
      this.timer.unref?.();
    }
  }
}

module.exports = { Discord, isWebhook, relayLine, escape };

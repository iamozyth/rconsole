'use strict';

// The page a friend opens from an invite link (/join/<token>): no sign-in,
// no script (the form posts back to the same address), the sign-in page's
// look. Everything that comes from the owner or the visitor is escaped.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const MARK = `<svg class="sprite" aria-hidden="true" focusable="false">
  <symbol id="pg-mark" viewBox="0 0 32 32">
    <rect class="mark-bg" width="32" height="32" rx="7"/>
    <path d="M16 6 25 11 16 16 7 11Z" fill="#fff"/>
    <path d="M7 12.6 15.2 17.2V26.6L7 22Z" fill="#fff" fill-opacity=".72"/>
    <path d="M25 12.6 16.8 17.2V26.6L25 22Z" fill="#fff" fill-opacity=".45"/>
  </symbol>
  <symbol id="pg-door" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M5 3h11.5A1.5 1.5 0 0 1 18 4.5V20h2v2H4v-2h1zm2.4 2.4V20h8.2V5.4zm5.6 6.1a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4z"/></symbol>
  <symbol id="pg-check" viewBox="0 0 24 24"><path d="M9.4 15.6 19.2 5.8l1.8 1.8L9.4 19.2 3 12.8l1.8-1.8z"/></symbol>
  <symbol id="pg-alert" viewBox="0 0 24 24"><path d="M12 2.5 22.5 21h-21zm-1.2 6.2v6.1h2.4V8.7zm0 7.6v2.4h2.4v-2.4z" fill-rule="evenodd"/></symbol>
</svg>`;

function shell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/style.css">
</head>
<body class="login-page" data-area="console">
${MARK}
<main class="login">
  <div class="login-brand"><svg class="mark" aria-hidden="true"><use href="#pg-mark"/></svg></div>
  <section class="panel login-card">
${body}
  </section>
</main>
</body>
</html>`;
}

const addressBlock = (address) => (address
  ? `<p class="invite-address"><span>Server address</span><code>${esc(address)}</code></p>`
  : '');

// state: 'form' (with optional error and the name typed), 'done', 'gone'.
function invitePage({ state, invite = null, error = '', name = '', result = null, server = '' }) {
  if (state === 'gone') {
    return shell('Invite expired · rconsole', `    <div class="login-head invite-body">
      <span class="login-badge"><svg><use href="#pg-alert"/></svg></span>
      <h1>This invite can't be used</h1>
      <p class="lede">It has expired, was used up or was withdrawn. Ask whoever sent it for a new link.</p>
    </div>`);
  }
  // The label is the owner's own note ("for Lena"); the friend sees the server's name.
  const where = server ? esc(server) : 'our Minecraft server';
  if (state === 'done') {
    const allowed = result?.status === 'allowed';
    return shell(`${allowed ? 'You\'re in' : 'Request sent'} · rconsole`, `    <div class="login-head invite-body">
      <span class="login-badge"><svg><use href="#pg-check"/></svg></span>
      <h1>${allowed ? `You're on the list, ${esc(result.name)}` : `Thanks, ${esc(result.name)}`}</h1>
      <p class="lede">${allowed ? `You can join ${where} now.` : 'The owner gets your request and lets you in. Try joining in a little while.'}</p>
      ${addressBlock(invite?.address)}
    </div>`);
  }
  return shell(`Join ${server || 'the server'} · rconsole`, `    <form method="post" autocomplete="off" novalidate>
      <div class="login-head">
        <span class="login-badge"><svg><use href="#pg-door"/></svg></span>
        <h1>You're invited to ${where}</h1>
        <p class="lede">Enter your Minecraft name${invite?.auto ? ' and you\'re added to the whitelist right away.' : '. The owner lets you in.'}</p>
      </div>
      <label class="fld"><span>Minecraft name</span>
        <input class="field" name="name" value="${esc(name)}" maxlength="16" autocapitalize="none" autocorrect="off" spellcheck="false" required autofocus${error ? ' aria-invalid="true"' : ''}>
      </label>
      ${error ? `<p class="login-error" role="alert"><svg><use href="#pg-alert"/></svg><span>${esc(error)}</span></p>` : ''}
      <button class="btn btn-primary login-submit">${invite?.auto ? 'Join the whitelist' : 'Ask to join'}</button>
      ${addressBlock(invite?.address)}
    </form>`);
}

module.exports = { invitePage, esc };

'use strict';

// Confirms a web address change from the new address (lib/listener.js). The
// token comes in the fragment, so it never reaches a proxy's access log.
const $ = (id) => document.getElementById(id);
const token = location.hash.slice(1);
$('host').textContent = location.host;

function fail(message) {
  $('error-text').textContent = message;
  $('error').hidden = false;
}

if (!token) {
  $('submit').hidden = true;
  fail('This link is missing its code. Open it again from Settings → System.');
}

$('confirm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const submit = $('submit');
  submit.dataset.state = 'busy';
  submit.disabled = true;
  $('error').hidden = true;
  try {
    const res = await fetch('/api/system/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    submit.hidden = true;
    $('open').className = 'btn btn-primary login-submit';
    $('title').textContent = 'Address saved';
    $('lede').textContent = `rconsole now listens on ${data.host}:${data.port} only. The old address is closed.`;
    $('open').hidden = false;
    history.replaceState(null, '', location.pathname);
  } catch (err) {
    submit.dataset.state = '';
    submit.disabled = false;
    fail(err.message);
  }
});

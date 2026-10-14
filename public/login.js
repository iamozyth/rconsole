'use strict';

const $ = (id) => document.getElementById(id);
const form = $('login');
const f = form.elements;
const submit = $('submit');
let step = 'password';

$('host').textContent = location.hostname;

function showError(message, field) {
  $('error-text').textContent = message;
  $('error').hidden = !message;
  for (const el of [f.username, f.password, f.code]) el.removeAttribute('aria-invalid');
  if (!message) return;
  if (field) field.setAttribute('aria-invalid', 'true');
  form.classList.remove('shake');
  void form.offsetWidth; // restart the animation
  form.classList.add('shake');
}

function setBusy(state) {
  // state: '' | 'busy' | 'done'
  submit.dataset.state = state;
  submit.disabled = Boolean(state);
  $('submit-text').textContent = state === 'busy' ? (step === 'code' ? 'Verifying…' : 'Signing in…') : state === 'done' ? 'Signed in' : step === 'code' ? 'Verify' : 'Continue';
}

function showStep(next) {
  step = next;
  const code = next === 'code';
  $('step-password').hidden = code;
  $('step-code').hidden = !code;
  $('back').hidden = !code;
  $('badge').hidden = !code;
  f.code.required = code;
  $('title').textContent = code ? 'Two-step verification' : 'Sign in to rconsole';
  $('lede').textContent = code ? `Enter the 6-digit code from your authenticator app for ${f.username.value.trim()}.` : 'Run your Minecraft server from anywhere.';
  form.dataset.step = next;
  showError('');
  setBusy('');
  (code ? f.code : f.username.value ? f.password : f.username).focus();
}

$('pw-toggle').addEventListener('click', () => {
  const show = f.password.type === 'password';
  f.password.type = show ? 'text' : 'password';
  $('pw-toggle').setAttribute('aria-pressed', String(show));
  $('pw-toggle').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  $('pw-toggle').querySelector('use').setAttribute('href', show ? '#pg-eye-off' : '#pg-eye');
  f.password.focus();
});

for (const type of ['keydown', 'keyup']) {
  f.password.addEventListener(type, (e) => {
    if (e.getModifierState) $('caps').hidden = !e.getModifierState('CapsLock');
  });
}
f.password.addEventListener('blur', () => ($('caps').hidden = true));

// Six digits typed or pasted: submit without an extra tap.
f.code.addEventListener('input', () => {
  const digits = f.code.value.replace(/\D/g, '').slice(0, 6);
  f.code.value = digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
  if (digits.length === 6 && submit.dataset.state !== 'busy') form.requestSubmit();
});

$('back').addEventListener('click', () => {
  f.code.value = '';
  f.password.value = '';
  showStep('password');
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submit.dataset.state) return;
  showError('');
  const missing = [f.username, f.password].find((i) => !i.value.trim());
  if (missing) return showError(`Enter your ${missing.name}.`, missing), missing.focus();
  if (step === 'code' && f.code.value.replace(/\D/g, '').length !== 6) return showError('Enter all 6 digits.', f.code), f.code.focus();
  setBusy('busy');
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: f.username.value, password: f.password.value, code: step === 'code' ? f.code.value : undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setBusy('done');
      form.classList.add('success');
      return setTimeout(() => location.replace('/'), 350);
    }
    if (data.needCode && step !== 'code') return showStep('code');
    setBusy('');
    if (step === 'code') {
      f.code.value = '';
      showError(data.error || 'That code did not work.', f.code);
      return f.code.focus();
    }
    showError(data.error || `Sign-in failed (HTTP ${res.status}).`, res.status === 401 ? f.password : null);
    f.password.select();
  } catch (err) {
    setBusy('');
    showError(`Can't reach rconsole: ${err.message}`);
  }
});

setBusy('');

// Single sign-on: shown first when configured; the password form becomes the
// fallback behind "or use a local account", or disappears when switched off.
const SSO_ERRORS = {
  sso_denied: (n) => `Your ${n} account doesn't have access to rconsole. Ask an admin to add you to one of its groups.`,
  sso_state: () => 'That sign-in expired or was started in another browser. Try again.',
  sso_failed: (n) => `Signing in with ${n} didn't work. Try again; if it keeps failing, the rconsole log says why.`,
  sso_unavailable: (n) => `Can't reach ${n} right now. Try again in a moment.`,
  sso_locked: () => 'Too many failed sign-ins from this address. Try again in 15 minutes.',
  sso_off: () => 'Single sign-on isn\'t set up on this server.',
};

function showLocal(open) {
  $('step-password').hidden = !open;
  submit.hidden = !open;
  $('local-toggle').hidden = open;
  $('local-toggle').setAttribute('aria-expanded', String(open));
  if (open) f.username.focus();
}

(async () => {
  const error = new URLSearchParams(location.search).get('error');
  if (error) history.replaceState(null, '', '/login');
  let cfg = { sso: null, local: true };
  try {
    cfg = await (await fetch('/api/auth-config')).json();
  } catch {}
  const name = cfg.sso?.name || 'SSO';
  if (cfg.sso) {
    $('sso').hidden = false;
    $('sso-text').textContent = `Continue with ${name}`;
    form.dataset.sso = 'on';
    submit.classList.remove('btn-primary'); // one primary action on the page
    $('foot-text').textContent = cfg.local ? `Access is managed in ${name}. Local accounts live on the server (cli.js).` : `Access is managed in ${name}.`;
    showLocal(false);
    $('local-toggle').hidden = !cfg.local;
    $('sso-btn').addEventListener('click', () => {
      $('sso-btn').dataset.state = 'busy';
      $('sso-text').textContent = `Opening ${name}…`;
    });
    $('local-toggle').addEventListener('click', () => showLocal(true));
  }
  if (error) showError((SSO_ERRORS[error] || SSO_ERRORS.sso_failed)(name));
})();

// Back from the provider with the browser's back button: the button is live again.
window.addEventListener('pageshow', (e) => {
  if (e.persisted && $('sso-btn').dataset.state) {
    delete $('sso-btn').dataset.state;
    $('sso-text').textContent = $('sso-text').textContent.replace(/^Opening (.*)…$/, 'Continue with $1');
  }
});

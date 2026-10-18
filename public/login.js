'use strict';

const $ = (id) => document.getElementById(id);
const form = $('login');
const f = form.elements;
const submit = $('submit');
let step = 'password';
let recovery = false; // a recovery code instead of the authenticator's

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
  if (!code) useRecovery(false);
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

// Lost phone: one of the codes printed when 2FA was set up, each works once.
function useRecovery(on) {
  recovery = on;
  Object.assign(f.code, on ? { inputMode: 'text', pattern: '[A-Za-z2-7]{5}-?[A-Za-z2-7]{5}', maxLength: 11, placeholder: 'ABCDE-FGHIJ', autocomplete: 'off' } : { inputMode: 'numeric', pattern: '[0-9 ]{6,7}', maxLength: 7, placeholder: '000 000', autocomplete: 'one-time-code' });
  f.code.value = '';
  $('use-recovery').textContent = on ? 'Use the authenticator app' : 'Use a recovery code';
  if (step === 'code') $('lede').textContent = on ? `Enter one of your recovery codes for ${f.username.value.trim()}. Each works once.` : `Enter the 6-digit code from your authenticator app for ${f.username.value.trim()}.`;
  showError('');
}
$('use-recovery').addEventListener('click', () => {
  useRecovery(!recovery);
  f.code.focus();
});

// Six digits typed or pasted: submit without an extra tap.
f.code.addEventListener('input', () => {
  if (recovery) return void (f.code.value = f.code.value.toUpperCase().replace(/[^A-Z2-7-]/g, ''));
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
  if (step === 'code' && recovery && !/^[A-Z2-7]{5}-?[A-Z2-7]{5}$/.test(f.code.value)) return showError('A recovery code has 10 letters and digits, like ABCDE-FGHIJ.', f.code), f.code.focus();
  if (step === 'code' && !recovery && f.code.value.replace(/\D/g, '').length !== 6) return showError('Enter all 6 digits.', f.code), f.code.focus();
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
      remember('local'); // next time this browser opens with the form ready to fill
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

// With SSO on, the password form waits behind "Use a local account". Password
// managers only fill fields on screen, so a browser that last signed in
// locally (or /login?local) gets the form open at once; otherwise one click
// opens it and focuses the username, where 1Password offers to fill.
const remember = (how) => {
  try {
    localStorage.setItem('rconsole.login', how);
  } catch {}
};
const remembered = () => {
  try {
    return localStorage.getItem('rconsole.login');
  } catch {
    return null;
  }
};

function showLocal(open) {
  $('step-password').hidden = !open;
  submit.hidden = !open;
  $('local-or').setAttribute('aria-expanded', String(open));
  $('local-or').classList.toggle('open', open);
  $('local-or-text').textContent = open ? 'or use a local account' : 'Use a local account';
}

(async () => {
  const params = new URLSearchParams(location.search);
  const error = params.get('error');
  const openLocal = params.has('local');
  if (error || openLocal) history.replaceState(null, '', '/login');
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
    if (cfg.local) {
      $('local-or').hidden = false;
      showLocal(openLocal || remembered() === 'local');
      $('local-or').addEventListener('click', () => {
        if ($('local-or').classList.contains('open')) return;
        showLocal(true);
        f.username.focus();
      });
    } else {
      $('step-password').hidden = true;
      submit.hidden = true;
    }
    $('sso-btn').addEventListener('click', () => {
      remember('sso');
      $('sso-btn').dataset.state = 'busy';
      $('sso-text').textContent = `Opening ${name}…`;
    });
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

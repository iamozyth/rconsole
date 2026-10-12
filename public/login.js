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

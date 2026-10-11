'use strict';

const form = document.getElementById('login');
const error = document.getElementById('error');
const codeRow = document.getElementById('code-row');
const submit = document.getElementById('submit');
const lede = document.getElementById('lede');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  const f = form.elements;
  const missing = [f.username, f.password].find((i) => !i.value.trim());
  if (missing) {
    error.textContent = `Enter your ${missing.name}.`;
    return missing.focus();
  }
  submit.disabled = true;
  submit.textContent = 'Signing in…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: f.username.value, password: f.password.value, code: f.code.value || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return location.replace('/');
    if (data.needCode) {
      const first = codeRow.hidden;
      codeRow.hidden = false;
      f.code.required = true;
      lede.textContent = 'Enter the 6-digit code from your authenticator app.';
      f.code.focus();
      if (first) return;
      f.code.value = '';
    }
    error.textContent = data.error || `Sign-in failed (HTTP ${res.status})`;
  } catch (err) {
    error.textContent = err.message;
  } finally {
    submit.disabled = false;
    submit.textContent = 'Sign in';
  }
});

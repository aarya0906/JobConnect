import { api, user, $, $$, ringsSvg, safeNext, formValues, showFieldErrors, withBusy } from './common.js';

const params = new URLSearchParams(location.search);
const next = safeNext(params.get('next'));
if (user) location.replace(next || '/dashboard');

$('#brand-rings').innerHTML = ringsSvg();
const suffix = next ? `?next=${encodeURIComponent(next)}` : '';
const toReg = $('#to-register'); if (toReg) toReg.href = '/register' + suffix;
const toLogin = $('#to-login'); if (toLogin) toLogin.href = '/login' + suffix;

$$('.pw-toggle').forEach((btn) => btn.addEventListener('click', () => {
  const input = btn.previousElementSibling;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? 'Hide' : 'Show';
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
}));

/* ---- Login ---- */
const loginForm = $('#login-form');
loginForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = formValues(loginForm);
  const errors = {};
  if (!v.email) errors.email = 'Enter your email address.';
  if (!v.password) errors.password = 'Enter your password.';
  if (Object.keys(errors).length) return showFieldErrors(loginForm, errors);
  showFieldErrors(loginForm, {});
  await withBusy($('button[type=submit]', loginForm), async () => {
    try {
      await api('/api/auth/login', { method: 'POST', body: v });
      location.href = next || '/dashboard';
    } catch (err) {
      showFieldErrors(loginForm, err.fields, err.message);
    }
  });
});

/* ---- Register ---- */
const regForm = $('#register-form');
if (regForm) {
  let role = params.get('role') === 'employer' ? 'employer' : 'seeker';
  const copy = {
    seeker: ['Your next role is one resume away.', 'Create a profile, upload your resume once and apply to as many roles as you like.'],
    employer: ['Post a role. Meet your next hire.', 'Set up your company, publish openings and manage every applicant from one dashboard.']
  };
  const setRole = (r) => {
    role = r;
    $$('.segmented button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.role === r));
    $('#company-field').hidden = r !== 'employer';
    $('#brand-title').textContent = copy[r][0];
    $('#brand-copy').textContent = copy[r][1];
    $('#name').autocomplete = 'name';
  };
  $$('.segmented button').forEach((b) => b.addEventListener('click', () => setRole(b.dataset.role)));
  setRole(role);

  regForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = formValues(regForm);
    const errors = {};
    if (v.name.length < 2) errors.name = 'Enter your full name.';
    if (role === 'employer' && (v.companyName || '').length < 2) errors.companyName = 'Enter your company name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) errors.email = 'Enter a valid email address.';
    if (v.password.length < 8 || !/[A-Za-z]/.test(v.password) || !/\d/.test(v.password)) errors.password = 'Use at least 8 characters, including a letter and a number.';
    if (Object.keys(errors).length) return showFieldErrors(regForm, errors);
    showFieldErrors(regForm, {});
    await withBusy($('button[type=submit]', regForm), async () => {
      try {
        await api('/api/auth/register', { method: 'POST', body: { ...v, role } });
        location.href = next || '/dashboard';
      } catch (err) {
        showFieldErrors(regForm, err.fields, err.message);
      }
    });
  });
}

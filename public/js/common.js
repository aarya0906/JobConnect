/* JobConnect — shared client module (API client, chrome, drawers, helpers) */

/* ---------- API --------------------------------------------------------- */
export async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error('Could not reach JobConnect. Check your connection and try again.');
  }
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    const err = new Error(data?.error || 'Something went wrong. Please try again.');
    err.status = res.status;
    err.fields = data?.fields || {};
    throw err;
  }
  return data;
}

export const META = await api('/api/meta');
export const user = (await api('/api/auth/me').catch(() => ({ user: null }))).user;

/* ---------- Helpers ----------------------------------------------------- */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const initial = (s) => (String(s || '?').trim()[0] || '?').toUpperCase();

export function timeAgo(iso) {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  const steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.345, 'week'], [12, 'month'], [Infinity, 'year']];
  let n = s;
  for (const [div, unit] of steps) {
    if (n < div) {
      const v = Math.floor(n);
      if (unit === 'second' || (unit === 'minute' && v < 1)) return 'Just now';
      if (unit === 'day' && v === 1) return 'Yesterday';
      return `${v} ${unit}${v > 1 ? 's' : ''} ago`;
    }
    n /= div;
  }
}
export const fmtDate = (iso) => new Date(iso).toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });

const SYMBOLS = { USD: '$', INR: '₹', EUR: '€', GBP: '£' };
export function fmtSalary(job) {
  if (!job.salary_min && !job.salary_max) return '';
  const nf = new Intl.NumberFormat(job.currency === 'INR' ? 'en-IN' : 'en', { notation: 'compact', maximumFractionDigits: 1 });
  const s = SYMBOLS[job.currency] || '';
  const per = job.type === 'Contract' ? '/mo' : '/yr';
  const [a, b] = [job.salary_min, job.salary_max];
  if (a && b) return `${s}${nf.format(a)} – ${s}${nf.format(b)}${per}`;
  return `${s}${nf.format(a || b)}${a ? '+' : ' max'}${per}`;
}
export const fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
export const statusBadge = (s) => `<span class="badge" data-status="${esc(s)}">${esc(META.statuses[s] || (s === 'open' ? 'Open' : s === 'closed' ? 'Closed' : s))}</span>`;
export const safeNext = (v) => (typeof v === 'string' && /^\/(?!\/)[\w\-./?=&%#]*$/.test(v) ? v : null);

/* ---------- Icons ------------------------------------------------------- */
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8M8 9h2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'
};
export const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

/* ---------- Signature motif: two linked rings ---------------------------- */
let ringUid = 0;
export function ringsSvg({ logo = false } = {}) {
  const id = `r${++ringUid}`;
  const grad = (o) => `<linearGradient id="${id}g" gradientUnits="userSpaceOnUse" x1="${o.x1}" y1="${o.y1}" x2="${o.x2}" y2="${o.y2}">
    <stop offset="0" stop-color="#f7f7f7"/><stop offset=".28" stop-color="#b9b9b9"/><stop offset=".5" stop-color="#fbfbfb"/><stop offset=".74" stop-color="#8a8a8a"/><stop offset="1" stop-color="#d9d9d9"/></linearGradient>`;
  if (logo) {
    return `<svg viewBox="0 0 76 48" aria-hidden="true"><defs>${grad({ x1: 0, y1: 0, x2: 76, y2: 48 })}
      <clipPath id="${id}c"><circle cx="38" cy="14.4" r="7"/></clipPath></defs>
      <g fill="none" stroke="url(#${id}g)" stroke-width="5">
        <circle cx="24" cy="24" r="17"/><circle cx="52" cy="24" r="17"/>
        <g clip-path="url(#${id}c)"><circle cx="24" cy="24" r="17" stroke="#000" stroke-width="9"/><circle cx="24" cy="24" r="17"/></g>
      </g></svg>`;
  }
  return `<svg class="rings" viewBox="0 0 620 520" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><defs>${grad({ x1: 40, y1: 40, x2: 580, y2: 480 })}
    <clipPath id="${id}c"><circle cx="310" cy="110" r="36"/></clipPath></defs>
    <g fill="none" class="ring-over">
      <circle cx="230" cy="260" r="196" stroke="#fff" stroke-opacity=".09" stroke-width="1.5"/>
      <circle cx="390" cy="260" r="196" stroke="#fff" stroke-opacity=".09" stroke-width="1.5"/>
      <g stroke="url(#${id}g)" stroke-width="22">
        <circle cx="230" cy="260" r="170"/><circle cx="390" cy="260" r="170"/>
        <g clip-path="url(#${id}c)"><circle cx="230" cy="260" r="170" stroke="#000" stroke-width="36"/><circle cx="230" cy="260" r="170"/></g>
      </g>
    </g></svg>`;
}

/* ---------- Chrome (header & footer) ------------------------------------ */
function mountChrome() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  const cur = (p) => (path === p ? ' aria-current="page"' : '');
  const header = $('#site-header');
  if (header) {
    header.className = 'site-header';
    header.innerHTML = `<div class="container bar">
      <a class="logo" href="/" aria-label="JobConnect home">${ringsSvg({ logo: true })}JobConnect</a>
      <nav class="nav" aria-label="Main">
        <a href="/jobs"${cur('/jobs')}>Browse jobs</a>
        ${user?.role === 'employer' ? '' : `<a href="/register?role=employer">For employers</a>`}
        <a href="/#how">How it works</a>
      </nav>
      <div class="header-actions">${user
        ? `<a class="btn btn-primary btn-sm" href="/dashboard">${icon('dashboard')}Dashboard</a><button class="btn btn-sm" id="logout-btn">Log out</button>`
        : `<a class="btn btn-sm" href="/login">Log in</a><a class="btn btn-primary btn-sm" href="/register">Create account</a>`}</div>
      <button class="btn btn-icon menu-toggle" aria-label="Menu" aria-expanded="false">${icon('menu')}</button></div>`;
    $('.menu-toggle', header).addEventListener('click', (e) => {
      const open = header.classList.toggle('open');
      e.currentTarget.setAttribute('aria-expanded', open);
    });
    $('#logout-btn')?.addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      location.href = '/';
    });
  }
  const footer = $('#site-footer');
  if (footer) {
    footer.className = 'site-footer';
    footer.innerHTML = `<div class="container"><div class="footer-grid">
      <div><a class="logo" href="/">${ringsSvg({ logo: true })}JobConnect</a><p>Hiring that runs both ways. Candidates find work that fits; employers find people who fit it.</p></div>
      <div><h4>Candidates</h4><ul><li><a href="/jobs">Browse jobs</a></li><li><a href="/register">Create a profile</a></li><li><a href="/dashboard">Your dashboard</a></li></ul></div>
      <div><h4>Employers</h4><ul><li><a href="/register?role=employer">Post a job</a></li><li><a href="/login">Employer log in</a></li><li><a href="/dashboard#company">Company profile</a></li></ul></div>
      <div><h4>JobConnect</h4><ul><li><a href="/#how">How it works</a></li><li><a href="/jobs">Latest openings</a></li></ul></div></div>
      <div class="footer-bottom"><span>© ${new Date().getFullYear()} JobConnect. All rights reserved.</span><span>Resumes are only shared with employers you apply to.</span></div></div>`;
  }
}
mountChrome();

/* ---------- Toasts -------------------------------------------------------- */
export function toast(message, type = 'ok') {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.className = 'toasts';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.append(box);
  }
  const t = document.createElement('div');
  t.className = 'toast' + (type === 'error' ? ' error' : '');
  t.innerHTML = `${icon(type === 'error' ? 'info' : 'check')}<span>${esc(message)}</span>`;
  box.append(t);
  setTimeout(() => t.remove(), 4200);
}

/* ---------- Drawer -------------------------------------------------------- */
let activeDrawer = null;
export function openDrawer({ head = '', body = '', foot = '', label = 'Details' } = {}) {
  activeDrawer?.close();
  const opener = document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'backdrop';
  const el = document.createElement('aside');
  el.className = 'drawer';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', label);
  el.tabIndex = -1;
  el.innerHTML = `<div class="drawer-head"><div data-head>${head}</div><button class="btn btn-icon" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="drawer-body">${body}</div><div class="drawer-foot" ${foot ? '' : 'hidden'}>${foot}</div>`;
  document.body.append(backdrop, el);
  document.body.style.overflow = 'hidden';
  el.focus();

  const api_ = {
    el,
    body: $('.drawer-body', el),
    foot: $('.drawer-foot', el),
    setHead(html) { $('[data-head]', el).innerHTML = html; },
    setFoot(html) { api_.foot.innerHTML = html; api_.foot.hidden = !html; },
    close() {
      document.removeEventListener('keydown', onKey);
      backdrop.remove(); el.remove();
      document.body.style.overflow = '';
      if (activeDrawer === api_) activeDrawer = null;
      opener?.focus?.();
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape') api_.close();
    if (e.key === 'Tab') { // keep focus inside the drawer
      const f = $$('a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])', el).filter((n) => n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('click', api_.close);
  $('[data-close]', el).addEventListener('click', api_.close);
  activeDrawer = api_;
  return api_;
}

/* ---------- Forms --------------------------------------------------------- */
export function formValues(form) {
  return Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
}
export function showFieldErrors(form, fields = {}, message = '') {
  $$('.field-error', form).forEach((n) => n.remove());
  $$('.invalid', form).forEach((n) => n.classList.remove('invalid'));
  $('.form-error', form)?.remove();
  let first = null;
  for (const [name, msg] of Object.entries(fields)) {
    const input = form.elements[name];
    if (!input) continue;
    input.classList?.add('invalid');
    input.setAttribute?.('aria-invalid', 'true');
    const p = document.createElement('div');
    p.className = 'field-error';
    p.textContent = msg;
    (input.closest('.field') || input.parentElement).append(p);
    first ||= input;
  }
  if (message && !first) {
    const d = document.createElement('div');
    d.className = 'form-error';
    d.setAttribute('role', 'alert');
    d.textContent = message;
    form.prepend(d);
  }
  first?.focus?.();
}
export async function withBusy(btn, fn) {
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner"></span>`;
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = label; }
}

/* ---------- Resume upload helpers ---------------------------------------- */
export function validateResume(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!META.resume.types.includes(ext)) return 'Upload a PDF, DOC or DOCX file.';
  if (file.size > META.resume.maxBytes) return 'Your file is larger than 5 MB. Compress it and try again.';
  if (file.size === 0) return 'That file is empty.';
  return null;
}
export async function uploadResume(file) {
  const err = validateResume(file);
  if (err) throw new Error(err);
  const form = new FormData();
  form.append('resume', file);
  return api('/api/profile/resume', { method: 'POST', form });
}
export const dropzoneHtml = (name = 'resume') => `<label class="dropzone" data-dropzone>
  ${icon('upload')}<strong>Drop your resume here, or browse</strong><span>PDF, DOC or DOCX · up to 5 MB</span>
  <input type="file" name="${name}" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"></label>`;
export function wireDropzone(root, onFile) {
  const zone = $('[data-dropzone]', root);
  if (!zone) return;
  const input = $('input[type=file]', zone);
  input.addEventListener('change', () => input.files[0] && onFile(input.files[0], input));
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('drag'); }));
  zone.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) { try { const dt = new DataTransfer(); dt.items.add(f); input.files = dt.files; } catch { /* older browsers */ } onFile(f, input); }
  });
}

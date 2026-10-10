import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, transaction, UPLOAD_DIR } from './db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, rateLimit, SESSION_COOKIE
} from './auth.js';
import { HttpError, readJson, readBody, parseMultipart, sendJson } from './http.js';
import * as C from './constants.js';

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const text = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254;
const nowIso = () => new Date().toISOString();

function money(v, label, errors) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e9) {
    errors[label] = 'Enter a valid amount.';
    return null;
  }
  return Math.round(n);
}

function fail(errors, message = 'Please fix the highlighted fields.') {
  if (Object.keys(errors).length) throw new HttpError(422, message, errors);
}

function requireUser(ctx, role) {
  if (!ctx.user) throw new HttpError(401, 'Log in to continue.');
  if (role && ctx.user.role !== role) {
    throw new HttpError(403, role === 'employer' ? 'This area is for employer accounts.' : 'This area is for job seeker accounts.');
  }
  return ctx.user;
}

function cookieHeader(req, value, maxAge) {
  const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
  return `${SESSION_COOKIE}=${value}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/** Delete an uploaded file once nothing references it any more. */
function removeResumeIfOrphaned(file) {
  if (!file) return;
  const used =
    db.prepare('SELECT 1 FROM profiles WHERE resume_file = ? LIMIT 1').get(file) ||
    db.prepare('SELECT 1 FROM applications WHERE resume_file = ? LIMIT 1').get(file);
  if (!used) fs.promises.unlink(path.join(UPLOAD_DIR, file)).catch(() => {});
}

function sendFile(res, file, downloadName) {
  const full = path.join(UPLOAD_DIR, path.basename(file));
  if (!fs.existsSync(full)) throw new HttpError(404, 'That file is no longer available.');
  const ext = path.extname(full).slice(1).toLowerCase();
  const safe = (downloadName || 'resume.' + ext).replace(/[^\w.\- ()]/g, '_');
  res.writeHead(200, {
    'Content-Type': C.RESUME_TYPES[ext] || 'application/octet-stream',
    'Content-Length': fs.statSync(full).size,
    'Content-Disposition': `attachment; filename="${safe}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store'
  });
  fs.createReadStream(full).pipe(res);
}

/* ------------------------------------------------------------------ */
/* Job queries                                                         */
/* ------------------------------------------------------------------ */

function jobSelect({ withApplicants = false } = {}) {
  return `
    SELECT j.*, c.name AS company_name, c.location AS company_location, c.industry AS company_industry,
           c.size AS company_size, c.website AS company_website, c.about AS company_about,
           ${withApplicants ? "(SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id AND a.status != 'withdrawn')" : '0'} AS applicants,
           EXISTS(SELECT 1 FROM applications a WHERE a.job_id = j.id AND a.seeker_id = :uid AND a.status != 'withdrawn') AS applied,
           EXISTS(SELECT 1 FROM saved_jobs s WHERE s.job_id = j.id AND s.user_id = :uid) AS saved
    FROM jobs j JOIN companies c ON c.user_id = j.employer_id`;
}

function shapeJob(row, { owner = false } = {}) {
  if (!row) return null;
  const job = { ...row, applied: !!row.applied, saved: !!row.saved };
  if (!owner) {
    delete job.applicants;
    delete job.employer_id;
  }
  return job;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

const routes = [];
const add = (method, pattern, handler) => {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, regex, keys, handler });
};

export async function handleApi(ctx) {
  const { req, res, url } = ctx;
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.regex.exec(url.pathname);
    if (!m) continue;
    ctx.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const out = await r.handler(ctx);
    if (!res.writableEnded && out !== undefined) sendJson(res, 200, out);
    return;
  }
  throw new HttpError(404, 'Unknown API endpoint.');
}

/* ----- Meta & stats ------------------------------------------------ */

add('GET', '/api/meta', () => ({
  categories: C.CATEGORIES,
  jobTypes: C.JOB_TYPES,
  workModes: C.WORK_MODES,
  currencies: C.CURRENCIES,
  companySizes: C.COMPANY_SIZES,
  statuses: C.APPLICATION_STATUSES,
  resume: { maxBytes: C.RESUME_MAX_BYTES, types: Object.keys(C.RESUME_TYPES) }
}));

add('GET', '/api/stats', () => {
  const one = (sql) => db.prepare(sql).get().n;
  return {
    openJobs: one("SELECT COUNT(*) AS n FROM jobs WHERE status = 'open'"),
    companies: one('SELECT COUNT(*) AS n FROM companies'),
    candidates: one("SELECT COUNT(*) AS n FROM users WHERE role = 'seeker'"),
    applications: one('SELECT COUNT(*) AS n FROM applications')
  };
});

add('GET', '/api/categories', () => {
  const rows = db.prepare("SELECT category, COUNT(*) AS n FROM jobs WHERE status = 'open' GROUP BY category").all();
  const counts = Object.fromEntries(rows.map((r) => [r.category, r.n]));
  return C.CATEGORIES.map((name) => ({ name, count: counts[name] || 0 }));
});

/* ----- Auth -------------------------------------------------------- */

add('POST', '/api/auth/register', async (ctx) => {
  const { req, res } = ctx;
  if (!rateLimit('reg:' + clientIp(req), 20)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  const b = await readJson(req);
  const errors = {};
  const name = text(b.name, 80);
  const email = text(b.email, 254).toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  const role = b.role === 'employer' ? 'employer' : 'seeker';
  const company = text(b.companyName, 120);

  if (name.length < 2) errors.name = 'Enter your full name.';
  if (!isEmail(email)) errors.email = 'Enter a valid email address.';
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password) || password.length > 200) {
    errors.password = 'Use at least 8 characters, including a letter and a number.';
  }
  if (role === 'employer' && company.length < 2) errors.companyName = 'Enter your company name.';
  fail(errors);

  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'An account with this email already exists.', { email: 'This email is already registered. Log in instead.' });
  }

  const { hash, salt } = await hashPassword(password);
  const userId = transaction(() => {
    const id = Number(db.prepare('INSERT INTO users (name, email, password_hash, salt, role) VALUES (?,?,?,?,?)')
      .run(name, email, hash, salt, role).lastInsertRowid);
    if (role === 'employer') db.prepare('INSERT INTO companies (user_id, name) VALUES (?,?)').run(id, company);
    else db.prepare('INSERT INTO profiles (user_id) VALUES (?)').run(id);
    return id;
  });

  const session = createSession(userId);
  sendJson(res, 201, { user: { id: userId, name, email, role } }, { 'Set-Cookie': cookieHeader(req, session.token, session.maxAge) });
});

add('POST', '/api/auth/login', async (ctx) => {
  const { req, res } = ctx;
  const b = await readJson(req);
  const email = text(b.email, 254).toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  if (!rateLimit(`login:${clientIp(req)}:${email}`, 8)) {
    throw new HttpError(429, 'Too many log in attempts. Try again in 15 minutes.');
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = user && (await verifyPassword(password, user.password_hash, user.salt));
  if (!ok) throw new HttpError(401, 'Email or password is incorrect.');
  const session = createSession(user.id);
  sendJson(res, 200, { user: { id: user.id, name: user.name, email: user.email, role: user.role } },
    { 'Set-Cookie': cookieHeader(req, session.token, session.maxAge) });
});

add('POST', '/api/auth/logout', (ctx) => {
  destroySession(ctx.token);
  sendJson(ctx.res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(ctx.req, '', 0) });
});

add('GET', '/api/auth/me', (ctx) => ({ user: ctx.user || null }));

/* ----- Public jobs ------------------------------------------------- */

add('GET', '/api/jobs', (ctx) => {
  const q = ctx.url.searchParams;
  const where = ["j.status = 'open'"];
  const params = { uid: ctx.user?.id ?? 0 };

  const kw = text(q.get('q') || '', 80);
  if (kw) {
    where.push('(j.title LIKE :kw OR c.name LIKE :kw OR j.description LIKE :kw OR j.category LIKE :kw)');
    params.kw = `%${kw}%`;
  }
  const loc = text(q.get('location') || '', 80);
  if (loc) {
    where.push('(j.location LIKE :loc OR j.work_mode = \'Remote\' AND :loc LIKE \'%remote%\')');
    params.loc = `%${loc}%`;
  }
  for (const [key, col, list] of [
    ['type', 'j.type', C.JOB_TYPES], ['mode', 'j.work_mode', C.WORK_MODES], ['category', 'j.category', C.CATEGORIES]
  ]) {
    const v = q.get(key);
    if (v && list.includes(v)) {
      where.push(`${col} = :${key}`);
      params[key] = v;
    }
  }

  const limit = Math.min(Math.max(parseInt(q.get('limit')) || 10, 1), 30);
  const page = Math.max(parseInt(q.get('page')) || 1, 1);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM jobs j JOIN companies c ON c.user_id = j.employer_id WHERE ${where.join(' AND ')}`)
    .get(Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'uid'))).n;

  const rows = db.prepare(`${jobSelect()} WHERE ${where.join(' AND ')} ORDER BY j.created_at DESC LIMIT :limit OFFSET :offset`)
    .all({ ...params, limit, offset: (page - 1) * limit });

  return { jobs: rows.map((r) => shapeJob(r)), total, page, pages: Math.max(Math.ceil(total / limit), 1) };
});

add('GET', '/api/jobs/:id', (ctx) => {
  const row = db.prepare(`${jobSelect({ withApplicants: true })} WHERE j.id = :id`).get({ id: Number(ctx.params.id), uid: ctx.user?.id ?? 0 });
  if (!row) throw new HttpError(404, 'This job could not be found.');
  const owner = ctx.user?.id === row.employer_id;
  if (row.status !== 'open' && !owner) throw new HttpError(404, 'This job is no longer open.');
  return { job: shapeJob(row, { owner }) };
});

/* ----- Seeker: profile & resume ------------------------------------ */

function loadProfile(userId) {
  return db.prepare(`
    SELECT u.id, u.name, u.email, p.headline, p.location, p.phone, p.skills, p.about,
           p.resume_name, p.resume_size, p.resume_uploaded_at, (p.resume_file IS NOT NULL) AS has_resume
    FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?`).get(userId);
}

function completeness(p) {
  const checks = [
    ['Upload your resume', !!p.has_resume],
    ['Add a headline', !!p.headline],
    ['Add your location', !!p.location],
    ['List your skills', !!p.skills],
    ['Write a short summary', !!p.about]
  ];
  const done = checks.filter((c) => c[1]).length;
  return { percent: Math.round((done / checks.length) * 100), checks: checks.map(([label, ok]) => ({ label, ok })) };
}

add('GET', '/api/profile', (ctx) => {
  requireUser(ctx, 'seeker');
  const p = loadProfile(ctx.user.id);
  return { profile: { ...p, has_resume: !!p.has_resume }, completeness: completeness(p) };
});

add('PUT', '/api/profile', async (ctx) => {
  requireUser(ctx, 'seeker');
  const b = await readJson(ctx.req);
  const errors = {};
  const name = text(b.name, 80);
  if (name.length < 2) errors.name = 'Enter your full name.';
  fail(errors);
  transaction(() => {
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, ctx.user.id);
    db.prepare('UPDATE profiles SET headline = ?, location = ?, phone = ?, skills = ?, about = ? WHERE user_id = ?')
      .run(text(b.headline, 120), text(b.location, 100), text(b.phone, 30), text(b.skills, 300), text(b.about, 2000), ctx.user.id);
  });
  const p = loadProfile(ctx.user.id);
  return { profile: { ...p, has_resume: !!p.has_resume }, completeness: completeness(p) };
});

add('POST', '/api/profile/resume', async (ctx) => {
  requireUser(ctx, 'seeker');
  const buf = await readBody(ctx.req, C.RESUME_MAX_BYTES + 64 * 1024);
  const { files } = parseMultipart(buf, ctx.req.headers['content-type']);
  const f = files.find((x) => x.name === 'resume');
  if (!f || !f.data.length) throw new HttpError(400, 'Choose a file to upload.');
  if (f.data.length > C.RESUME_MAX_BYTES) throw new HttpError(413, 'Your file is larger than 5 MB. Compress it and try again.');

  const ext = path.extname(f.filename).slice(1).toLowerCase();
  if (!C.RESUME_TYPES[ext]) throw new HttpError(415, 'Upload a PDF, DOC or DOCX file.');
  const head = f.data.subarray(0, 8);
  const okMagic =
    (ext === 'pdf' && head.subarray(0, 4).toString('latin1') === '%PDF') ||
    (ext === 'docx' && head[0] === 0x50 && head[1] === 0x4b) ||
    (ext === 'doc' && head[0] === 0xd0 && head[1] === 0xcf);
  if (!okMagic) throw new HttpError(415, `That file doesn't look like a real ${ext.toUpperCase()}. Export it again and retry.`);

  const stored = `${crypto.randomUUID()}.${ext}`;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, stored), f.data, { mode: 0o600 });
  const displayName = path.basename(f.filename).replace(/[^\w.\- ()]/g, '_').slice(0, 100) || `resume.${ext}`;

  const old = db.prepare('SELECT resume_file FROM profiles WHERE user_id = ?').get(ctx.user.id)?.resume_file;
  db.prepare('UPDATE profiles SET resume_file = ?, resume_name = ?, resume_size = ?, resume_uploaded_at = ? WHERE user_id = ?')
    .run(stored, displayName, f.data.length, nowIso(), ctx.user.id);
  if (old) removeResumeIfOrphaned(old);

  const p = loadProfile(ctx.user.id);
  return { profile: { ...p, has_resume: !!p.has_resume }, completeness: completeness(p) };
});

add('DELETE', '/api/profile/resume', (ctx) => {
  requireUser(ctx, 'seeker');
  const old = db.prepare('SELECT resume_file FROM profiles WHERE user_id = ?').get(ctx.user.id)?.resume_file;
  db.prepare('UPDATE profiles SET resume_file = NULL, resume_name = NULL, resume_size = NULL, resume_uploaded_at = NULL WHERE user_id = ?').run(ctx.user.id);
  removeResumeIfOrphaned(old);
  const p = loadProfile(ctx.user.id);
  return { profile: { ...p, has_resume: !!p.has_resume }, completeness: completeness(p) };
});

add('GET', '/api/profile/resume', (ctx) => {
  requireUser(ctx, 'seeker');
  const p = db.prepare('SELECT resume_file, resume_name FROM profiles WHERE user_id = ?').get(ctx.user.id);
  if (!p?.resume_file) throw new HttpError(404, 'You have not uploaded a resume yet.');
  sendFile(ctx.res, p.resume_file, p.resume_name);
});

/* ----- Seeker: applications & saved jobs --------------------------- */

add('POST', '/api/jobs/:id/apply', async (ctx) => {
  requireUser(ctx, 'seeker');
  const b = await readJson(ctx.req);
  const job = db.prepare('SELECT id, status FROM jobs WHERE id = ?').get(Number(ctx.params.id));
  if (!job || job.status !== 'open') throw new HttpError(404, 'This job is no longer accepting applications.');
  const prof = db.prepare('SELECT resume_file, resume_name FROM profiles WHERE user_id = ?').get(ctx.user.id);
  if (!prof?.resume_file) throw new HttpError(422, 'Upload your resume before applying.', { resume: 'A resume is required to apply.' });

  const note = text(b.coverNote, 3000);
  const existing = db.prepare('SELECT id, status FROM applications WHERE job_id = ? AND seeker_id = ?').get(job.id, ctx.user.id);
  if (existing && existing.status !== 'withdrawn') throw new HttpError(409, 'You have already applied to this job.');

  if (existing) {
    db.prepare("UPDATE applications SET status = 'applied', cover_note = ?, resume_file = ?, resume_name = ?, created_at = ?, updated_at = ? WHERE id = ?")
      .run(note, prof.resume_file, prof.resume_name, nowIso(), nowIso(), existing.id);
  } else {
    db.prepare('INSERT INTO applications (job_id, seeker_id, cover_note, resume_file, resume_name) VALUES (?,?,?,?,?)')
      .run(job.id, ctx.user.id, note, prof.resume_file, prof.resume_name);
  }
  ctx.res.statusCode = 201;
  sendJson(ctx.res, 201, { ok: true });
});

add('GET', '/api/applications', (ctx) => {
  requireUser(ctx, 'seeker');
  const rows = db.prepare(`
    SELECT a.id, a.status, a.cover_note, a.created_at, a.updated_at,
           j.id AS job_id, j.title, j.location, j.type, j.work_mode, j.status AS job_status,
           c.name AS company_name
    FROM applications a JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.user_id = j.employer_id
    WHERE a.seeker_id = ? ORDER BY a.created_at DESC`).all(ctx.user.id);
  return { applications: rows };
});

add('POST', '/api/applications/:id/withdraw', (ctx) => {
  requireUser(ctx, 'seeker');
  const app = db.prepare('SELECT id, status FROM applications WHERE id = ? AND seeker_id = ?').get(Number(ctx.params.id), ctx.user.id);
  if (!app) throw new HttpError(404, 'Application not found.');
  if (['hired', 'withdrawn'].includes(app.status)) throw new HttpError(409, 'This application can no longer be withdrawn.');
  db.prepare("UPDATE applications SET status = 'withdrawn', updated_at = ? WHERE id = ?").run(nowIso(), app.id);
  return { ok: true };
});

add('GET', '/api/saved', (ctx) => {
  requireUser(ctx, 'seeker');
  const rows = db.prepare(`${jobSelect()} JOIN saved_jobs sj ON sj.job_id = j.id AND sj.user_id = :uid
    WHERE j.status = 'open' ORDER BY sj.created_at DESC`).all({ uid: ctx.user.id });
  return { jobs: rows.map((r) => shapeJob(r)) };
});

add('POST', '/api/jobs/:id/save', (ctx) => {
  requireUser(ctx, 'seeker');
  const id = Number(ctx.params.id);
  if (!db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(id)) throw new HttpError(404, 'Job not found.');
  const has = db.prepare('SELECT 1 FROM saved_jobs WHERE user_id = ? AND job_id = ?').get(ctx.user.id, id);
  if (has) db.prepare('DELETE FROM saved_jobs WHERE user_id = ? AND job_id = ?').run(ctx.user.id, id);
  else db.prepare('INSERT INTO saved_jobs (user_id, job_id) VALUES (?,?)').run(ctx.user.id, id);
  return { saved: !has };
});

add('GET', '/api/seeker/overview', (ctx) => {
  requireUser(ctx, 'seeker');
  const uid = ctx.user.id;
  const counts = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(status IN ('reviewing','shortlisted')) AS active,
           SUM(status = 'interview') AS interviews,
           SUM(status = 'hired') AS hired
    FROM applications WHERE seeker_id = ? AND status != 'withdrawn'`).get(uid);
  const saved = db.prepare('SELECT COUNT(*) AS n FROM saved_jobs WHERE user_id = ?').get(uid).n;
  const recent = db.prepare(`
    SELECT a.id, a.status, a.created_at, j.id AS job_id, j.title, c.name AS company_name
    FROM applications a JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.user_id = j.employer_id
    WHERE a.seeker_id = ? ORDER BY a.created_at DESC LIMIT 5`).all(uid);
  const recommended = db.prepare(`${jobSelect()} WHERE j.status = 'open'
    AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id AND a.seeker_id = :uid)
    ORDER BY j.created_at DESC LIMIT 4`).all({ uid }).map((r) => shapeJob(r));
  const p = loadProfile(uid);
  return {
    stats: { applications: counts.total || 0, active: counts.active || 0, interviews: counts.interviews || 0, hired: counts.hired || 0, saved },
    recent, recommended, completeness: completeness(p)
  };
});

/* ----- Employer: company ------------------------------------------- */

add('GET', '/api/company', (ctx) => {
  requireUser(ctx, 'employer');
  return { company: db.prepare('SELECT * FROM companies WHERE user_id = ?').get(ctx.user.id) };
});

add('PUT', '/api/company', async (ctx) => {
  requireUser(ctx, 'employer');
  const b = await readJson(ctx.req);
  const errors = {};
  const name = text(b.name, 120);
  if (name.length < 2) errors.name = 'Enter your company name.';
  let website = text(b.website, 200);
  if (website) {
    if (!/^https?:\/\//i.test(website)) website = 'https://' + website;
    try { new URL(website); } catch { errors.website = 'Enter a valid website address.'; }
  }
  const size = text(b.size, 20);
  if (size && !C.COMPANY_SIZES.includes(size)) errors.size = 'Choose a company size from the list.';
  fail(errors);
  db.prepare('UPDATE companies SET name = ?, industry = ?, size = ?, website = ?, location = ?, about = ? WHERE user_id = ?')
    .run(name, text(b.industry, 80), size, website, text(b.location, 100), text(b.about, 3000), ctx.user.id);
  return { company: db.prepare('SELECT * FROM companies WHERE user_id = ?').get(ctx.user.id) };
});

/* ----- Employer: jobs ---------------------------------------------- */

function validateJob(b) {
  const errors = {};
  const title = text(b.title, 120);
  if (title.length < 3) errors.title = 'Enter a job title (at least 3 characters).';
  const category = text(b.category, 40);
  if (!C.CATEGORIES.includes(category)) errors.category = 'Choose a category.';
  const type = text(b.type, 20);
  if (!C.JOB_TYPES.includes(type)) errors.type = 'Choose an employment type.';
  const work_mode = text(b.work_mode, 20);
  if (!C.WORK_MODES.includes(work_mode)) errors.work_mode = 'Choose a work mode.';
  let location = text(b.location, 100);
  if (!location && work_mode === 'Remote') location = 'Anywhere';
  if (!location) errors.location = 'Enter a location.';
  const currency = C.CURRENCIES.includes(b.currency) ? b.currency : 'USD';
  const salary_min = money(b.salary_min, 'salary_min', errors);
  const salary_max = money(b.salary_max, 'salary_max', errors);
  if (salary_min !== null && salary_max !== null && salary_max < salary_min) errors.salary_max = 'Maximum must be at least the minimum.';
  const description = text(b.description, 8000);
  if (description.length < 30) errors.description = 'Describe the role in at least 30 characters.';
  const requirements = text(b.requirements, 4000);
  fail(errors);
  return { title, category, type, work_mode, location, currency, salary_min, salary_max, description, requirements };
}

add('GET', '/api/employer/jobs', (ctx) => {
  requireUser(ctx, 'employer');
  const rows = db.prepare(`${jobSelect({ withApplicants: true })} WHERE j.employer_id = :eid ORDER BY j.created_at DESC`)
    .all({ eid: ctx.user.id, uid: 0 });
  return { jobs: rows.map((r) => shapeJob(r, { owner: true })) };
});

add('POST', '/api/employer/jobs', async (ctx) => {
  requireUser(ctx, 'employer');
  const j = validateJob(await readJson(ctx.req));
  const id = Number(db.prepare(`INSERT INTO jobs (employer_id, title, category, type, work_mode, location, currency, salary_min, salary_max, description, requirements)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(ctx.user.id, j.title, j.category, j.type, j.work_mode, j.location, j.currency, j.salary_min, j.salary_max, j.description, j.requirements).lastInsertRowid);
  sendJson(ctx.res, 201, { id });
});

add('PUT', '/api/employer/jobs/:id', async (ctx) => {
  requireUser(ctx, 'employer');
  const id = Number(ctx.params.id);
  if (!db.prepare('SELECT 1 FROM jobs WHERE id = ? AND employer_id = ?').get(id, ctx.user.id)) throw new HttpError(404, 'Job not found.');
  const j = validateJob(await readJson(ctx.req));
  db.prepare(`UPDATE jobs SET title=?, category=?, type=?, work_mode=?, location=?, currency=?, salary_min=?, salary_max=?, description=?, requirements=?, updated_at=? WHERE id = ?`)
    .run(j.title, j.category, j.type, j.work_mode, j.location, j.currency, j.salary_min, j.salary_max, j.description, j.requirements, nowIso(), id);
  return { id };
});

add('POST', '/api/employer/jobs/:id/status', async (ctx) => {
  requireUser(ctx, 'employer');
  const b = await readJson(ctx.req);
  if (!['open', 'closed'].includes(b.status)) throw new HttpError(422, 'Status must be open or closed.');
  const r = db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND employer_id = ?').run(b.status, nowIso(), Number(ctx.params.id), ctx.user.id);
  if (!r.changes) throw new HttpError(404, 'Job not found.');
  return { status: b.status };
});

add('DELETE', '/api/employer/jobs/:id', (ctx) => {
  requireUser(ctx, 'employer');
  const id = Number(ctx.params.id);
  if (!db.prepare('SELECT 1 FROM jobs WHERE id = ? AND employer_id = ?').get(id, ctx.user.id)) throw new HttpError(404, 'Job not found.');
  const files = db.prepare('SELECT DISTINCT resume_file FROM applications WHERE job_id = ? AND resume_file IS NOT NULL').all(id).map((r) => r.resume_file);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  files.forEach(removeResumeIfOrphaned);
  return { ok: true };
});

/* ----- Employer: applicants ---------------------------------------- */

const APPLICANT_SQL = `
  SELECT a.id, a.status, a.cover_note, a.created_at, a.updated_at, a.resume_name, (a.resume_file IS NOT NULL) AS has_resume,
         u.id AS seeker_id, u.name, u.email, p.headline, p.location, p.phone, p.skills, p.about,
         j.id AS job_id, j.title AS job_title
  FROM applications a
  JOIN jobs j ON j.id = a.job_id
  JOIN users u ON u.id = a.seeker_id
  LEFT JOIN profiles p ON p.user_id = u.id
  WHERE j.employer_id = :eid`;

add('GET', '/api/employer/applicants', (ctx) => {
  requireUser(ctx, 'employer');
  const q = ctx.url.searchParams;
  const params = { eid: ctx.user.id };
  let sql = APPLICANT_SQL;
  if (q.get('job_id')) { sql += ' AND j.id = :job'; params.job = Number(q.get('job_id')); }
  if (q.get('status') && C.APPLICATION_STATUSES[q.get('status')]) { sql += ' AND a.status = :status'; params.status = q.get('status'); }
  sql += ' ORDER BY a.created_at DESC LIMIT 500';
  return { applicants: db.prepare(sql).all(params).map((r) => ({ ...r, has_resume: !!r.has_resume })) };
});

add('POST', '/api/applications/:id/status', async (ctx) => {
  requireUser(ctx, 'employer');
  const b = await readJson(ctx.req);
  if (!C.APPLICATION_STATUSES[b.status] || b.status === 'withdrawn') throw new HttpError(422, 'Choose a valid status.');
  const app = db.prepare('SELECT a.id, a.status FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ? AND j.employer_id = ?')
    .get(Number(ctx.params.id), ctx.user.id);
  if (!app) throw new HttpError(404, 'Application not found.');
  if (app.status === 'withdrawn') throw new HttpError(409, 'The candidate withdrew this application.');
  db.prepare('UPDATE applications SET status = ?, updated_at = ? WHERE id = ?').run(b.status, nowIso(), app.id);
  return { status: b.status };
});

add('GET', '/api/applications/:id/resume', (ctx) => {
  requireUser(ctx);
  const id = Number(ctx.params.id);
  const row = ctx.user.role === 'employer'
    ? db.prepare('SELECT a.resume_file, a.resume_name FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ? AND j.employer_id = ?').get(id, ctx.user.id)
    : db.prepare('SELECT resume_file, resume_name FROM applications WHERE id = ? AND seeker_id = ?').get(id, ctx.user.id);
  if (!row?.resume_file) throw new HttpError(404, 'No resume was attached to this application.');
  sendFile(ctx.res, row.resume_file, row.resume_name);
});

add('GET', '/api/employer/overview', (ctx) => {
  requireUser(ctx, 'employer');
  const eid = ctx.user.id;
  const jobs = db.prepare("SELECT COUNT(*) AS total, SUM(status = 'open') AS open FROM jobs WHERE employer_id = ?").get(eid);
  const pipeline = Object.fromEntries(Object.keys(C.APPLICATION_STATUSES).map((k) => [k, 0]));
  db.prepare(`SELECT a.status, COUNT(*) AS n FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.employer_id = ? GROUP BY a.status`)
    .all(eid).forEach((r) => { pipeline[r.status] = r.n; });
  const total = Object.entries(pipeline).filter(([k]) => k !== 'withdrawn').reduce((s, [, n]) => s + n, 0);
  const recent = db.prepare(`${APPLICANT_SQL} ORDER BY a.created_at DESC LIMIT 6`).all({ eid }).map((r) => ({ ...r, has_resume: !!r.has_resume }));
  const topJobs = db.prepare(`${jobSelect({ withApplicants: true })} WHERE j.employer_id = :eid ORDER BY applicants DESC, j.created_at DESC LIMIT 5`)
    .all({ eid, uid: 0 }).map((r) => shapeJob(r, { owner: true }));
  return {
    stats: {
      openJobs: jobs.open || 0, totalJobs: jobs.total || 0, applicants: total,
      toReview: pipeline.applied, shortlisted: pipeline.shortlisted + pipeline.interview, hired: pipeline.hired
    },
    pipeline, recent, topJobs
  };
});

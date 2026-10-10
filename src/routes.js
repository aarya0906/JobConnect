import path from 'node:path';
import crypto from 'node:crypto';
import { all, get, run, tx } from './db.js';
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
/** Escape %, _ and \ so user input is matched literally inside LIKE patterns. */
const like = (s) => '%' + s.replace(/[\\%_]/g, '\\$&') + '%';

function intId(v, what = 'item') {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw new HttpError(404, `That ${what} could not be found.`);
  return n;
}

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

/* ----- Resume storage (kept in the database, so it survives restarts) ----- */

/** Delete a stored resume once nothing references it any more. */
async function removeResumeIfOrphaned(id, q = { run }) {
  if (!id) return;
  await q.run(
    `DELETE FROM resume_files WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM profiles WHERE resume_file = $1)
       AND NOT EXISTS (SELECT 1 FROM applications WHERE resume_file = $1)`, [id]);
}

async function sendResume(res, fileId, downloadName) {
  const f = await get('SELECT ext, data FROM resume_files WHERE id = $1', [fileId]);
  if (!f) throw new HttpError(404, 'That file is no longer available.');
  const safe = (downloadName || `resume.${f.ext}`).replace(/[^\w.\- ()]/g, '_');
  res.writeHead(200, {
    'Content-Type': C.RESUME_TYPES[f.ext] || 'application/octet-stream',
    'Content-Length': f.data.length,
    'Content-Disposition': `attachment; filename="${safe}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store'
  });
  res.end(f.data);
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

add('GET', '/api/stats', async () => {
  const row = await get(`
    SELECT (SELECT COUNT(*) FROM jobs WHERE status = 'open') AS open_jobs,
           (SELECT COUNT(*) FROM companies) AS companies,
           (SELECT COUNT(*) FROM users WHERE role = 'seeker') AS candidates,
           (SELECT COUNT(*) FROM applications) AS applications`);
  return { openJobs: row.open_jobs, companies: row.companies, candidates: row.candidates, applications: row.applications };
});

add('GET', '/api/categories', async () => {
  const rows = await all("SELECT category, COUNT(*) AS n FROM jobs WHERE status = 'open' GROUP BY category");
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

  const taken = () => new HttpError(409, 'An account with this email already exists.', { email: 'This email is already registered. Log in instead.' });
  if (await get('SELECT 1 AS x FROM users WHERE lower(email) = $1', [email])) throw taken();

  const { hash, salt } = await hashPassword(password);
  let userId;
  try {
    userId = await tx(async (q) => {
      const row = await q.get('INSERT INTO users (name, email, password_hash, salt, role) VALUES ($1,$2,$3,$4,$5) RETURNING id', [name, email, hash, salt, role]);
      if (role === 'employer') await q.run('INSERT INTO companies (user_id, name) VALUES ($1,$2)', [row.id, company]);
      else await q.run('INSERT INTO profiles (user_id) VALUES ($1)', [row.id]);
      return row.id;
    });
  } catch (err) {
    if (err.code === '23505') throw taken(); // two people registering the same email at once
    throw err;
  }

  const session = await createSession(userId);
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
  const user = await get('SELECT * FROM users WHERE lower(email) = $1', [email]);
  const ok = user && (await verifyPassword(password, user.password_hash, user.salt));
  if (!ok) throw new HttpError(401, 'Email or password is incorrect.');
  const session = await createSession(user.id);
  sendJson(res, 200, { user: { id: user.id, name: user.name, email: user.email, role: user.role } },
    { 'Set-Cookie': cookieHeader(req, session.token, session.maxAge) });
});

add('POST', '/api/auth/logout', async (ctx) => {
  await destroySession(ctx.token);
  sendJson(ctx.res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(ctx.req, '', 0) });
});

add('GET', '/api/auth/me', (ctx) => ({ user: ctx.user || null }));

/* ----- Public jobs ------------------------------------------------- */

add('GET', '/api/jobs', async (ctx) => {
  const q = ctx.url.searchParams;
  const where = ["j.status = 'open'"];
  const params = { uid: ctx.user?.id ?? 0 };

  const kw = text(q.get('q') || '', 80);
  if (kw) {
    where.push("(j.title ILIKE :kw ESCAPE '\\' OR c.name ILIKE :kw ESCAPE '\\' OR j.description ILIKE :kw ESCAPE '\\' OR j.category ILIKE :kw ESCAPE '\\')");
    params.kw = like(kw);
  }
  const loc = text(q.get('location') || '', 80);
  if (loc) {
    where.push(/remote/i.test(loc)
      ? "(j.location ILIKE :loc ESCAPE '\\' OR j.work_mode = 'Remote')"
      : "j.location ILIKE :loc ESCAPE '\\'");
    params.loc = like(loc);
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
  const whereSql = where.join(' AND ');

  const [{ n: total }, rows] = await Promise.all([
    get(`SELECT COUNT(*) AS n FROM jobs j JOIN companies c ON c.user_id = j.employer_id WHERE ${whereSql}`, params),
    all(`${jobSelect()} WHERE ${whereSql} ORDER BY j.created_at DESC, j.id DESC LIMIT :limit OFFSET :offset`,
      { ...params, limit, offset: (page - 1) * limit })
  ]);

  return { jobs: rows.map((r) => shapeJob(r)), total, page, pages: Math.max(Math.ceil(total / limit), 1) };
});

add('GET', '/api/jobs/:id', async (ctx) => {
  const id = intId(ctx.params.id, 'job');
  const row = await get(`${jobSelect({ withApplicants: true })} WHERE j.id = :id`, { id, uid: ctx.user?.id ?? 0 });
  if (!row) throw new HttpError(404, 'This job could not be found.');
  const owner = ctx.user?.id === row.employer_id;
  if (row.status !== 'open' && !owner) throw new HttpError(404, 'This job is no longer open.');
  return { job: shapeJob(row, { owner }) };
});

/* ----- Seeker: profile & resume ------------------------------------ */

async function loadProfile(userId) {
  return get(`
    SELECT u.id, u.name, u.email, p.headline, p.location, p.phone, p.skills, p.about,
           p.resume_name, p.resume_size, p.resume_uploaded_at, (p.resume_file IS NOT NULL) AS has_resume
    FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`, [userId]);
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

async function profileResponse(userId) {
  const p = await loadProfile(userId);
  return { profile: { ...p, has_resume: !!p.has_resume }, completeness: completeness(p) };
}

add('GET', '/api/profile', async (ctx) => {
  requireUser(ctx, 'seeker');
  return profileResponse(ctx.user.id);
});

add('PUT', '/api/profile', async (ctx) => {
  requireUser(ctx, 'seeker');
  const b = await readJson(ctx.req);
  const errors = {};
  const name = text(b.name, 80);
  if (name.length < 2) errors.name = 'Enter your full name.';
  fail(errors);
  await tx(async (q) => {
    await q.run('UPDATE users SET name = $1 WHERE id = $2', [name, ctx.user.id]);
    await q.run('UPDATE profiles SET headline = $1, location = $2, phone = $3, skills = $4, about = $5 WHERE user_id = $6',
      [text(b.headline, 120), text(b.location, 100), text(b.phone, 30), text(b.skills, 300), text(b.about, 2000), ctx.user.id]);
  });
  return profileResponse(ctx.user.id);
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

  const fileId = crypto.randomUUID();
  const displayName = path.basename(f.filename).replace(/[^\w.\- ()]/g, '_').slice(0, 100) || `resume.${ext}`;

  await tx(async (q) => {
    const old = (await q.get('SELECT resume_file FROM profiles WHERE user_id = $1', [ctx.user.id]))?.resume_file;
    await q.run('INSERT INTO resume_files (id, ext, size, data) VALUES ($1,$2,$3,$4)', [fileId, ext, f.data.length, f.data]);
    await q.run('UPDATE profiles SET resume_file = $1, resume_name = $2, resume_size = $3, resume_uploaded_at = $4 WHERE user_id = $5',
      [fileId, displayName, f.data.length, nowIso(), ctx.user.id]);
    await removeResumeIfOrphaned(old, q);
  });
  return profileResponse(ctx.user.id);
});

add('DELETE', '/api/profile/resume', async (ctx) => {
  requireUser(ctx, 'seeker');
  await tx(async (q) => {
    const old = (await q.get('SELECT resume_file FROM profiles WHERE user_id = $1', [ctx.user.id]))?.resume_file;
    await q.run('UPDATE profiles SET resume_file = NULL, resume_name = NULL, resume_size = NULL, resume_uploaded_at = NULL WHERE user_id = $1', [ctx.user.id]);
    await removeResumeIfOrphaned(old, q);
  });
  return profileResponse(ctx.user.id);
});

add('GET', '/api/profile/resume', async (ctx) => {
  requireUser(ctx, 'seeker');
  const p = await get('SELECT resume_file, resume_name FROM profiles WHERE user_id = $1', [ctx.user.id]);
  if (!p?.resume_file) throw new HttpError(404, 'You have not uploaded a resume yet.');
  await sendResume(ctx.res, p.resume_file, p.resume_name);
});

/* ----- Seeker: applications & saved jobs --------------------------- */

add('POST', '/api/jobs/:id/apply', async (ctx) => {
  requireUser(ctx, 'seeker');
  const jobId = intId(ctx.params.id, 'job');
  const b = await readJson(ctx.req);
  const job = await get('SELECT id, status FROM jobs WHERE id = $1', [jobId]);
  if (!job || job.status !== 'open') throw new HttpError(404, 'This job is no longer accepting applications.');
  const prof = await get('SELECT resume_file, resume_name FROM profiles WHERE user_id = $1', [ctx.user.id]);
  if (!prof?.resume_file) throw new HttpError(422, 'Upload your resume before applying.', { resume: 'A resume is required to apply.' });

  const note = text(b.coverNote, 3000);
  const existing = await get('SELECT id, status FROM applications WHERE job_id = $1 AND seeker_id = $2', [job.id, ctx.user.id]);
  if (existing && existing.status !== 'withdrawn') throw new HttpError(409, 'You have already applied to this job.');

  if (existing) {
    await run("UPDATE applications SET status = 'applied', cover_note = $1, resume_file = $2, resume_name = $3, created_at = $4, updated_at = $4 WHERE id = $5",
      [note, prof.resume_file, prof.resume_name, nowIso(), existing.id]);
  } else {
    try {
      await run('INSERT INTO applications (job_id, seeker_id, cover_note, resume_file, resume_name) VALUES ($1,$2,$3,$4,$5)',
        [job.id, ctx.user.id, note, prof.resume_file, prof.resume_name]);
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'You have already applied to this job.');
      throw err;
    }
  }
  sendJson(ctx.res, 201, { ok: true });
});

add('GET', '/api/applications', async (ctx) => {
  requireUser(ctx, 'seeker');
  const rows = await all(`
    SELECT a.id, a.status, a.cover_note, a.created_at, a.updated_at,
           j.id AS job_id, j.title, j.location, j.type, j.work_mode, j.status AS job_status,
           c.name AS company_name
    FROM applications a JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.user_id = j.employer_id
    WHERE a.seeker_id = $1 ORDER BY a.created_at DESC`, [ctx.user.id]);
  return { applications: rows };
});

add('POST', '/api/applications/:id/withdraw', async (ctx) => {
  requireUser(ctx, 'seeker');
  const app = await get('SELECT id, status FROM applications WHERE id = $1 AND seeker_id = $2', [intId(ctx.params.id, 'application'), ctx.user.id]);
  if (!app) throw new HttpError(404, 'Application not found.');
  if (['hired', 'withdrawn'].includes(app.status)) throw new HttpError(409, 'This application can no longer be withdrawn.');
  await run("UPDATE applications SET status = 'withdrawn', updated_at = $1 WHERE id = $2", [nowIso(), app.id]);
  return { ok: true };
});

add('GET', '/api/saved', async (ctx) => {
  requireUser(ctx, 'seeker');
  const rows = await all(`${jobSelect()} JOIN saved_jobs sj ON sj.job_id = j.id AND sj.user_id = :uid
    WHERE j.status = 'open' ORDER BY sj.created_at DESC`, { uid: ctx.user.id });
  return { jobs: rows.map((r) => shapeJob(r)) };
});

add('POST', '/api/jobs/:id/save', async (ctx) => {
  requireUser(ctx, 'seeker');
  const id = intId(ctx.params.id, 'job');
  if (!(await get('SELECT 1 AS x FROM jobs WHERE id = $1', [id]))) throw new HttpError(404, 'Job not found.');
  const has = await get('SELECT 1 AS x FROM saved_jobs WHERE user_id = $1 AND job_id = $2', [ctx.user.id, id]);
  if (has) await run('DELETE FROM saved_jobs WHERE user_id = $1 AND job_id = $2', [ctx.user.id, id]);
  else await run('INSERT INTO saved_jobs (user_id, job_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [ctx.user.id, id]);
  return { saved: !has };
});

add('GET', '/api/seeker/overview', async (ctx) => {
  requireUser(ctx, 'seeker');
  const uid = ctx.user.id;
  const [counts, savedRow, recent, recommended, prof] = await Promise.all([
    get(`SELECT COUNT(*) AS total,
                COUNT(*) FILTER (WHERE status IN ('reviewing','shortlisted')) AS active,
                COUNT(*) FILTER (WHERE status = 'interview') AS interviews,
                COUNT(*) FILTER (WHERE status = 'hired') AS hired
         FROM applications WHERE seeker_id = $1 AND status != 'withdrawn'`, [uid]),
    get('SELECT COUNT(*) AS n FROM saved_jobs WHERE user_id = $1', [uid]),
    all(`SELECT a.id, a.status, a.created_at, j.id AS job_id, j.title, c.name AS company_name
         FROM applications a JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.user_id = j.employer_id
         WHERE a.seeker_id = $1 ORDER BY a.created_at DESC LIMIT 5`, [uid]),
    all(`${jobSelect()} WHERE j.status = 'open'
         AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id AND a.seeker_id = :uid)
         ORDER BY j.created_at DESC, j.id DESC LIMIT 4`, { uid }),
    loadProfile(uid)
  ]);
  return {
    stats: { applications: counts.total, active: counts.active, interviews: counts.interviews, hired: counts.hired, saved: savedRow.n },
    recent, recommended: recommended.map((r) => shapeJob(r)), completeness: completeness(prof)
  };
});

/* ----- Employer: company ------------------------------------------- */

add('GET', '/api/company', async (ctx) => {
  requireUser(ctx, 'employer');
  return { company: await get('SELECT * FROM companies WHERE user_id = $1', [ctx.user.id]) };
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
  await run('UPDATE companies SET name = $1, industry = $2, size = $3, website = $4, location = $5, about = $6 WHERE user_id = $7',
    [name, text(b.industry, 80), size, website, text(b.location, 100), text(b.about, 3000), ctx.user.id]);
  return { company: await get('SELECT * FROM companies WHERE user_id = $1', [ctx.user.id]) };
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

add('GET', '/api/employer/jobs', async (ctx) => {
  requireUser(ctx, 'employer');
  const rows = await all(`${jobSelect({ withApplicants: true })} WHERE j.employer_id = :eid ORDER BY j.created_at DESC, j.id DESC`,
    { eid: ctx.user.id, uid: 0 });
  return { jobs: rows.map((r) => shapeJob(r, { owner: true })) };
});

add('POST', '/api/employer/jobs', async (ctx) => {
  requireUser(ctx, 'employer');
  const j = validateJob(await readJson(ctx.req));
  const row = await get(`INSERT INTO jobs (employer_id, title, category, type, work_mode, location, currency, salary_min, salary_max, description, requirements)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [ctx.user.id, j.title, j.category, j.type, j.work_mode, j.location, j.currency, j.salary_min, j.salary_max, j.description, j.requirements]);
  sendJson(ctx.res, 201, { id: row.id });
});

add('PUT', '/api/employer/jobs/:id', async (ctx) => {
  requireUser(ctx, 'employer');
  const id = intId(ctx.params.id, 'job');
  if (!(await get('SELECT 1 AS x FROM jobs WHERE id = $1 AND employer_id = $2', [id, ctx.user.id]))) throw new HttpError(404, 'Job not found.');
  const j = validateJob(await readJson(ctx.req));
  await run(`UPDATE jobs SET title=$1, category=$2, type=$3, work_mode=$4, location=$5, currency=$6, salary_min=$7, salary_max=$8,
             description=$9, requirements=$10, updated_at=$11 WHERE id = $12`,
    [j.title, j.category, j.type, j.work_mode, j.location, j.currency, j.salary_min, j.salary_max, j.description, j.requirements, nowIso(), id]);
  return { id };
});

add('POST', '/api/employer/jobs/:id/status', async (ctx) => {
  requireUser(ctx, 'employer');
  const b = await readJson(ctx.req);
  if (!['open', 'closed'].includes(b.status)) throw new HttpError(422, 'Status must be open or closed.');
  const r = await run('UPDATE jobs SET status = $1, updated_at = $2 WHERE id = $3 AND employer_id = $4', [b.status, nowIso(), intId(ctx.params.id, 'job'), ctx.user.id]);
  if (!r.rowCount) throw new HttpError(404, 'Job not found.');
  return { status: b.status };
});

add('DELETE', '/api/employer/jobs/:id', async (ctx) => {
  requireUser(ctx, 'employer');
  const id = intId(ctx.params.id, 'job');
  if (!(await get('SELECT 1 AS x FROM jobs WHERE id = $1 AND employer_id = $2', [id, ctx.user.id]))) throw new HttpError(404, 'Job not found.');
  await tx(async (q) => {
    const files = (await q.all('SELECT DISTINCT resume_file FROM applications WHERE job_id = $1 AND resume_file IS NOT NULL', [id])).map((r) => r.resume_file);
    await q.run('DELETE FROM jobs WHERE id = $1', [id]);
    for (const f of files) await removeResumeIfOrphaned(f, q);
  });
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

const shapeApplicant = (r) => ({ ...r, has_resume: !!r.has_resume });

add('GET', '/api/employer/applicants', async (ctx) => {
  requireUser(ctx, 'employer');
  const q = ctx.url.searchParams;
  const params = { eid: ctx.user.id };
  let sql = APPLICANT_SQL;
  if (q.get('job_id')) { sql += ' AND j.id = :job'; params.job = intId(q.get('job_id'), 'job'); }
  if (q.get('status') && C.APPLICATION_STATUSES[q.get('status')]) { sql += ' AND a.status = :status'; params.status = q.get('status'); }
  sql += ' ORDER BY a.created_at DESC, a.id DESC LIMIT 500';
  return { applicants: (await all(sql, params)).map(shapeApplicant) };
});

add('POST', '/api/applications/:id/status', async (ctx) => {
  requireUser(ctx, 'employer');
  const b = await readJson(ctx.req);
  if (!C.APPLICATION_STATUSES[b.status] || b.status === 'withdrawn') throw new HttpError(422, 'Choose a valid status.');
  const app = await get('SELECT a.id, a.status FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = $1 AND j.employer_id = $2',
    [intId(ctx.params.id, 'application'), ctx.user.id]);
  if (!app) throw new HttpError(404, 'Application not found.');
  if (app.status === 'withdrawn') throw new HttpError(409, 'The candidate withdrew this application.');
  await run('UPDATE applications SET status = $1, updated_at = $2 WHERE id = $3', [b.status, nowIso(), app.id]);
  return { status: b.status };
});

add('GET', '/api/applications/:id/resume', async (ctx) => {
  requireUser(ctx);
  const id = intId(ctx.params.id, 'application');
  const row = ctx.user.role === 'employer'
    ? await get('SELECT a.resume_file, a.resume_name FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = $1 AND j.employer_id = $2', [id, ctx.user.id])
    : await get('SELECT resume_file, resume_name FROM applications WHERE id = $1 AND seeker_id = $2', [id, ctx.user.id]);
  if (!row?.resume_file) throw new HttpError(404, 'No resume was attached to this application.');
  await sendResume(ctx.res, row.resume_file, row.resume_name);
});

add('GET', '/api/employer/overview', async (ctx) => {
  requireUser(ctx, 'employer');
  const eid = ctx.user.id;
  const [jobs, pipeRows, recent, topJobs] = await Promise.all([
    get("SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'open') AS open FROM jobs WHERE employer_id = $1", [eid]),
    all('SELECT a.status, COUNT(*) AS n FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.employer_id = $1 GROUP BY a.status', [eid]),
    all(`${APPLICANT_SQL} ORDER BY a.created_at DESC, a.id DESC LIMIT 6`, { eid }),
    all(`${jobSelect({ withApplicants: true })} WHERE j.employer_id = :eid ORDER BY applicants DESC, j.created_at DESC LIMIT 5`, { eid, uid: 0 })
  ]);
  const pipeline = Object.fromEntries(Object.keys(C.APPLICATION_STATUSES).map((k) => [k, 0]));
  pipeRows.forEach((r) => { pipeline[r.status] = r.n; });
  const total = Object.entries(pipeline).filter(([k]) => k !== 'withdrawn').reduce((s, [, n]) => s + n, 0);
  return {
    stats: {
      openJobs: jobs.open, totalJobs: jobs.total, applicants: total,
      toReview: pipeline.applied, shortlisted: pipeline.shortlisted + pipeline.interview, hired: pipeline.hired
    },
    pipeline, recent: recent.map(shapeApplicant), topJobs: topJobs.map((r) => shapeJob(r, { owner: true }))
  };
});

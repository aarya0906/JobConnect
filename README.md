# JobConnect

A complete online job portal with a black-and-silver interface.

- **Candidates** create a profile, **upload a resume (PDF / DOC / DOCX)**, apply to jobs, save roles and track every application.
- **Employers** set up a company profile, post / edit / close jobs, review applicants, download resumes and move candidates through a hiring pipeline.
- Separate **dashboards** for each role, plus **login / register** pages and a public job board with search and filters.

It runs on **Node.js 22.13+ with zero npm dependencies** — the database is the SQLite module built into Node, so there is nothing to install.

---

## Quick start

```bash
cd jobconnect
npm start          # or: node server.js
```

Open **http://localhost:3000**.

On the very first start the app seeds demo companies, 14 jobs and sample applicants so you can explore straight away.

| Role      | Email                        | Password    |
|-----------|------------------------------|-------------|
| Employer  | `employer@jobconnect.demo`   | `Demo@1234` |
| Candidate | `seeker@jobconnect.demo`     | `Demo@1234` |

> **Before going live:** start with `SEED_DEMO=0` on a fresh `DATA_DIR` (or delete the `data/` folder first) so the demo accounts and their shared password never exist in production.

Check your Node version with `node -v` — it must be **22.13 or newer**.

---

## Project structure

```
server.js            HTTP server, security headers, static files
src/
  routes.js          REST API (auth, jobs, profile & resume, applications, employer tools)
  db.js              SQLite schema (users, companies, profiles, jobs, applications, saved_jobs, sessions)
  auth.js            scrypt password hashing, server-side sessions, rate limiting
  http.js            JSON/multipart parsing, cookies, static file serving
  seed.js            Demo data (npm run seed)
  constants.js       Categories, job types, statuses, upload limits
public/
  index.html         Landing page          jobs.html       Job board
  login.html         Log in                register.html   Create account (candidate or employer)
  dashboard.html     Candidate + employer dashboards
  css/styles.css     The whole black & silver design system
  js/                common.js (API, header, drawer, helpers) · jobview.js · home.js · jobs.js · auth.js · dashboard.js
data/                Created at runtime: jobconnect.db + uploads/ (resumes)
Dockerfile           Container image
```

## Features in detail

**Public:** landing page with live stats, category browser, latest jobs · job board with keyword, location, field, type and work-mode filters, pagination and a detail drawer.

**Candidate dashboard:** overview with stats and profile-strength checklist · applications with live status and withdraw · saved jobs · profile editor · resume upload with drag-and-drop, replace, download and remove. A resume can also be uploaded straight from the apply form.

**Employer dashboard:** overview with hiring pipeline chart · job management (create, edit, close / reopen, delete) · applicant table with filters by job and status · applicant drawer with cover note, skills and resume download · status updates (Applied → In review → Shortlisted → Interview → Hired / Not selected) · company profile.

## Resume uploads

- Accepted: `.pdf`, `.doc`, `.docx`, up to **5 MB**. The limit and types live in `src/constants.js`.
- Files are checked by extension **and** file signature (magic bytes), stored under a random name in `DATA_DIR/uploads` (not web-accessible), and served only through authenticated endpoints:
  candidates can download their own; an employer can download only resumes of people who applied to **their** jobs.
- Each application keeps a snapshot of the resume used at the time, so replacing your profile resume later doesn't change what an employer already received.

## Configuration

| Variable        | Default  | Purpose |
|-----------------|----------|---------|
| `PORT`          | `3000`   | HTTP port |
| `DATA_DIR`      | `./data` | Database + uploaded resumes. **Use a persistent disk in production.** |
| `SEED_DEMO`     | `1`      | Set `0` to skip demo data on an empty database |
| `TRUST_PROXY`   | `0`      | Set `1` behind a proxy/PaaS so rate limiting uses the real client IP |
| `COOKIE_SECURE` | `0`      | Force the `Secure` cookie flag (auto-enabled when the proxy sends `X-Forwarded-Proto: https`) |

## Deploying

The app is a single process that needs **a persistent folder** for `DATA_DIR` (SQLite file + resumes). Always serve it over **HTTPS**.

**Docker**
```bash
docker build -t jobconnect .
docker run -d -p 3000:3000 -v jobconnect-data:/data -e SEED_DEMO=0 jobconnect
```

**Render / Railway / Fly.io** — create a web service from this folder (or its Docker image), attach a persistent disk/volume, set `DATA_DIR` to the mount path (e.g. `/data`), `TRUST_PROXY=1`, `SEED_DEMO=0`, and use the start command `npm start`. Health check path: `/healthz`.

**VPS (Ubuntu + Nginx)**
1. Install Node 22 and copy the project to `/srv/jobconnect`.
2. Run it with systemd (or pm2): `PORT=3000 TRUST_PROXY=1 SEED_DEMO=0 DATA_DIR=/srv/jobconnect-data node --disable-warning=ExperimentalWarning server.js`
3. Put Nginx in front with a Let's Encrypt certificate and proxy to `127.0.0.1:3000`, forwarding `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`. Set `client_max_body_size 6m;` so resume uploads aren't blocked.

## Security notes

- Passwords hashed with **scrypt** (per-user salt); sessions are random tokens stored hashed in the database, sent as `HttpOnly` + `SameSite=Lax` cookies.
- All SQL is parameterised; all user content is HTML-escaped on render; a strict Content-Security-Policy is sent (scripts from `self` only).
- State-changing API calls reject cross-origin requests; login and registration are rate limited.
- Role checks happen on the server for every endpoint — employers can only see and change their own jobs and applicants.

## Known limitations / ideas for next steps

- No email verification, password reset or email notifications yet (add an SMTP provider such as Postmark or SES).
- SQLite suits a single server. To scale out, move to PostgreSQL and S3-compatible storage for resumes.
- `node:sqlite` is marked experimental by Node.js; the warning is suppressed in the npm scripts. The API used here is stable in practice, but pin your Node version in production.
- Add an admin role for moderation if you open registration to the public.

## Customising the look

All colours, fonts and spacing are CSS variables at the top of `public/css/styles.css` (`--silver-*`, `--metal`, `--font-display`, …). The linked-rings logo is generated in `public/js/common.js` (`ringsSvg`).

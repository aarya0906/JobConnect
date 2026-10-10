# JobConnect

A complete online job portal with a black-and-silver interface.

- **Candidates** create a profile, **upload a resume (PDF / DOC / DOCX)**, apply to jobs, save roles and track every application.
- **Employers** set up a company profile, post / edit / close jobs, review applicants, download resumes and move candidates through a hiring pipeline.
- Separate dashboards for each role, login / register pages, and a public job board with search and filters.

**Stack:** Node.js 22+ · PostgreSQL (built for [Neon](https://neon.tech)) · plain HTML/CSS/JS front end. One dependency: `pg`.

All data — accounts, jobs, applications **and uploaded resumes** — lives in your Neon database, so the web server itself keeps no files. That is what lets the site run on a free host whose disk is wiped on every restart (e.g. Render Free) without losing data.

---

## Run it on your computer

1. Install Node.js 22.9 or newer (`node -v` to check).
2. In the project folder, create a file named `.env` (copy `.env.example`) and paste your Neon connection string:
   ```
   DATABASE_URL=postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require
   ```
3. Install, check the connection, and start:
   ```bash
   npm install
   npm run check-db     # confirms the connection and creates the tables
   npm start            # → http://localhost:3000
   ```

Optional sample data (jobs, companies, applicants) for an **empty** database: run once with `SEED_DEMO=1`
(Mac/Linux: `SEED_DEMO=1 npm start` · Windows PowerShell: `$env:SEED_DEMO=1; npm start`), or run `npm run seed`.

| Demo role | Email | Password |
|---|---|---|
| Employer | `employer@jobconnect.demo` | `Demo@1234` |
| Candidate | `seeker@jobconnect.demo` | `Demo@1234` |

> Don't seed a database that real users will use — those accounts share a public password.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | — (required) | Neon / PostgreSQL connection string |
| `PORT` | `3000` | HTTP port (Render sets this for you) |
| `SEED_DEMO` | `0` | `1` = fill an empty database with demo data on start |
| `TRUST_PROXY` | `0` | `1` behind a proxy/PaaS so rate limiting uses the real client IP |
| `COOKIE_SECURE` | `0` | Force the `Secure` cookie flag (automatic behind HTTPS proxies) |
| `DB_POOL_MAX` | `8` | Max database connections |

## Project structure

```
server.js            HTTP server, security headers, static files
src/
  db.js              Postgres pool, query helpers, schema (created automatically)
  routes.js          REST API (auth, jobs, profile & resume, applications, employer tools)
  auth.js            scrypt password hashing, sessions stored in the database, rate limiting
  http.js            JSON/multipart parsing, cookies, static file serving
  seed.js            Optional demo data
  check-db.js        `npm run check-db` — connection diagnostics
  constants.js       Categories, job types, statuses, upload limits
public/              The whole front end (HTML, css/styles.css, js/*)
Dockerfile           Container image
```

## Resume uploads

- Accepted: `.pdf`, `.doc`, `.docx`, up to **5 MB** (limit in `src/constants.js`).
- Checked by extension **and** file signature, stored in the `resume_files` table, and served only through authenticated endpoints: a candidate can download their own; an employer only resumes of people who applied to **their** jobs.
- Each application keeps a snapshot of the resume used when applying; replacing your profile resume later doesn't change what an employer already received. Unreferenced files are deleted automatically.
- Neon's free plan has a storage cap (check neon.tech/pricing for the current figure). Typical resumes are a few hundred KB, so this goes a long way, but keep an eye on usage in the Neon dashboard.

## Deploying

See the step-by-step guide given with this project (Render Free + Neon). In short, on any Node host:

- Build command `npm install`, start command `npm start`, health check `/healthz`
- Environment: `DATABASE_URL`, `NODE_VERSION=22`, `TRUST_PROXY=1`, `SEED_DEMO=0`
- Serve over HTTPS (Render does this automatically)

**Docker:** `docker build -t jobconnect .` then `docker run -p 3000:3000 -e DATABASE_URL="..." jobconnect`

## Security notes

- Passwords hashed with **scrypt** (per-user salt); sessions are random tokens stored hashed in the database, sent as `HttpOnly` + `SameSite=Lax` cookies.
- All SQL is parameterised; user content is HTML-escaped on render; a strict Content-Security-Policy is sent.
- State-changing API calls reject cross-origin requests; login and registration are rate limited.
- Role checks run on the server for every endpoint — employers only see their own jobs and applicants.
- Keep `DATABASE_URL` secret (never commit it). If it leaks, reset the password in Neon.

## Known limitations / next steps

- No email verification, password reset or email notifications yet (add an email provider such as Resend or Postmark).
- Free tiers sleep: Render Free after ~15 minutes idle, Neon after ~5 minutes idle. The first visit after a quiet period is slower; no data is lost.
- Add an admin role for moderation if you open registration to the public.

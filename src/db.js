import pg from 'pg';

/* --------------------------------------------------------------------------
   PostgreSQL (Neon) connection.
   Set DATABASE_URL to your Neon connection string.
   -------------------------------------------------------------------------- */

// BIGINT (int8) values — ids, COUNT(*), expiry timestamps — come back as numbers, not strings.
pg.types.setTypeParser(20, (v) => Number(v));

function buildPoolConfig() {
  let raw = (process.env.DATABASE_URL || '').trim();
  // Be forgiving if the whole `psql '...'` command or surrounding quotes were pasted.
  raw = raw.replace(/^psql\s+/i, '').replace(/^['"]|['"]$/g, '');
  if (!raw) {
    console.error('\n[JobConnect] DATABASE_URL is not set.\n' +
      'Add your Neon connection string as the DATABASE_URL environment variable, e.g.\n' +
      '  postgresql://user:password@ep-xxxx.region.aws.neon.tech/neondb?sslmode=require\n');
    process.exit(1);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    console.error('\n[JobConnect] DATABASE_URL is not a valid URL. Paste only the connection string that starts with postgresql://\n');
    process.exit(1);
  }
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  // We pass SSL explicitly, so drop the URL flags that newer drivers warn about.
  url.searchParams.delete('sslmode');
  url.searchParams.delete('channel_binding');
  return {
    connectionString: url.toString(),
    ssl: local || process.env.DATABASE_SSL === '0' ? false : { rejectUnauthorized: true },
    max: Number(process.env.DB_POOL_MAX) || 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000, // Neon can take a moment to wake from idle
    keepAlive: true
  };
}

export const pool = new pg.Pool(buildPoolConfig());
// Neon closes idle connections when the database suspends; never let that crash the process.
pool.on('error', (err) => console.warn('[db] idle connection dropped:', err.message));

/** Turn `:name` placeholders into `$1, $2…` (arrays pass through untouched). */
function prepare(sql, params) {
  if (!params || Array.isArray(params)) return [sql, params || []];
  const values = [];
  const seen = {};
  const text = sql.replace(/(?<!:):([a-zA-Z_]\w*)/g, (_, name) => {
    if (!(name in params)) throw new Error(`Missing SQL parameter :${name}`);
    if (!(name in seen)) { values.push(params[name]); seen[name] = values.length; }
    return '$' + seen[name];
  });
  return [text, values];
}

const isConnectionError = (e) =>
  /terminated unexpectedly|ECONNRESET|ECONNREFUSED|EPIPE|Connection terminated|timeout exceeded when trying to connect/i.test(e?.message || '') ||
  ['ECONNRESET', 'EPIPE', '57P01', '08006', '08003'].includes(e?.code);

async function exec(runner, sql, params) {
  const [text, values] = prepare(sql, params);
  try {
    return await runner.query(text, values);
  } catch (err) {
    // A connection that Neon closed while idle fails once; a second attempt gets a fresh one.
    if (runner === pool && isConnectionError(err)) return runner.query(text, values);
    throw err;
  }
}

export const all = async (sql, params) => (await exec(pool, sql, params)).rows;
export const get = async (sql, params) => (await exec(pool, sql, params)).rows[0];
export const run = async (sql, params) => exec(pool, sql, params);

/** Run several statements atomically on one connection. */
export async function tx(fn) {
  const client = await pool.connect();
  const q = {
    all: async (sql, params) => (await exec(client, sql, params)).rows,
    get: async (sql, params) => (await exec(client, sql, params)).rows[0],
    run: async (sql, params) => exec(client, sql, params)
  };
  try {
    await client.query('BEGIN');
    const out = await fn(q);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('seeker','employer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  user_id  BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT '',
  size     TEXT NOT NULL DEFAULT '',
  website  TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  about    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS resume_files (
  id         TEXT PRIMARY KEY,
  ext        TEXT NOT NULL,
  size       INTEGER NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id            BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  headline           TEXT NOT NULL DEFAULT '',
  location           TEXT NOT NULL DEFAULT '',
  phone              TEXT NOT NULL DEFAULT '',
  skills             TEXT NOT NULL DEFAULT '',
  about              TEXT NOT NULL DEFAULT '',
  resume_file        TEXT,
  resume_name        TEXT,
  resume_size        INTEGER,
  resume_uploaded_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS jobs (
  id           BIGSERIAL PRIMARY KEY,
  employer_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  category     TEXT NOT NULL,
  type         TEXT NOT NULL,
  work_mode    TEXT NOT NULL,
  location     TEXT NOT NULL DEFAULT '',
  currency     TEXT NOT NULL DEFAULT 'USD',
  salary_min   INTEGER,
  salary_max   INTEGER,
  description  TEXT NOT NULL,
  requirements TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS applications (
  id          BIGSERIAL PRIMARY KEY,
  job_id      BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seeker_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cover_note  TEXT NOT NULL DEFAULT '',
  resume_file TEXT,
  resume_name TEXT,
  status      TEXT NOT NULL DEFAULT 'applied',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, seeker_id)
);

CREATE TABLE IF NOT EXISTS saved_jobs (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id     BIGINT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_status   ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_employer ON jobs(employer_id);
CREATE INDEX IF NOT EXISTS idx_apps_job      ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_apps_seeker   ON applications(seeker_id);
`;

/** Creates any missing tables. Safe to run on every start. */
export async function initSchema() {
  await pool.query(SCHEMA);
}

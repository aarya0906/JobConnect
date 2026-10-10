import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'jobconnect.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('seeker','employer')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  user_id  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  industry TEXT DEFAULT '',
  size     TEXT DEFAULT '',
  website  TEXT DEFAULT '',
  location TEXT DEFAULT '',
  about    TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  headline           TEXT DEFAULT '',
  location           TEXT DEFAULT '',
  phone              TEXT DEFAULT '',
  skills             TEXT DEFAULT '',
  about              TEXT DEFAULT '',
  resume_file        TEXT,
  resume_name        TEXT,
  resume_size        INTEGER,
  resume_uploaded_at TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  employer_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS applications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  seeker_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cover_note  TEXT DEFAULT '',
  resume_file TEXT,
  resume_name TEXT,
  status      TEXT NOT NULL DEFAULT 'applied',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (job_id, seeker_id)
);

CREATE TABLE IF NOT EXISTS saved_jobs (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_status   ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_employer ON jobs(employer_id);
CREATE INDEX IF NOT EXISTS idx_apps_job      ON applications(job_id);
CREATE INDEX IF NOT EXISTS idx_apps_seeker   ON applications(seeker_id);
`);

/** Run several statements atomically. */
export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

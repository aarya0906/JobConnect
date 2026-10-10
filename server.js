import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, initSchema, pool } from './src/db.js';
import { getSessionUser, purgeExpiredSessions, SESSION_COOKIE } from './src/auth.js';
import { HttpError, parseCookies, sendJson, serveStatic } from './src/http.js';
import { handleApi } from './src/routes.js';
import { seedDemoData } from './src/seed.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'"
  ].join('; ')
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  try {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true });

    if (url.pathname.startsWith('/api/')) {
      // Basic CSRF defence: state-changing requests must come from our own origin.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin) {
          let host = '';
          try { host = new URL(origin).host; } catch { /* invalid origin */ }
          if (host !== req.headers.host) throw new HttpError(403, 'Cross-site requests are not allowed.');
        }
      }
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const ctx = { req, res, url, token, user: await getSessionUser(token), params: {} };
      return await handleApi(ctx);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    serveStatic(req, res, PUBLIC_DIR, url.pathname);
  } catch (err) {
    if (res.headersSent) return res.destroy();
    if (err instanceof HttpError) {
      return sendJson(res, err.status, { error: err.message, ...(err.fields ? { fields: err.fields } : {}) });
    }
    console.error('[error]', err);
    sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.' });
  }
});

// Start listening straight away so the host's health check passes, then prepare the database.
server.listen(PORT, HOST, () => console.log(`JobConnect is running → http://localhost:${PORT}`));

try {
  await initSchema();
  console.log('Database ready.');
  if (process.env.SEED_DEMO === '1') {
    const { n } = await get('SELECT COUNT(*) AS n FROM users');
    if (n === 0) {
      await seedDemoData();
      console.log('Seeded demo data (SEED_DEMO=1).');
    }
  }
  await purgeExpiredSessions();
  setInterval(() => purgeExpiredSessions().catch(() => {}), 6 * 3600 * 1000).unref();
} catch (err) {
  console.error('\n[JobConnect] Could not set up the database:', err.message);
  console.error('Run `npm run check-db` for help diagnosing the connection.\n');
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => pool.end().finally(() => process.exit(0))));
}

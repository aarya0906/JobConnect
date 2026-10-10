// Run with: npm run check-db
// Confirms your DATABASE_URL works, creates the tables, and prints what it found.
import { all, get, initSchema, pool } from './db.js';

const hint = (err) => {
  const m = `${err.code || ''} ${err.message || ''}`;
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'The host name was not found. Re-copy the connection string from the Neon dashboard (Connect button).';
  if (/28P01|password authentication failed/i.test(m)) return 'The username or password is wrong. In Neon use "Reset password" or re-copy the full connection string.';
  if (/3D000|does not exist/i.test(m)) return 'The database name in the URL does not exist. Neon\'s default is "neondb".';
  if (/ETIMEDOUT|timeout/i.test(m)) return 'The connection timed out. Check your internet connection / firewall, and that the Neon project is not paused.';
  if (/self.signed|certificate|SSL/i.test(m)) return 'SSL problem. Use the Neon connection string unchanged (it requires SSL).';
  return 'Check that DATABASE_URL is the full connection string from Neon, starting with postgresql://';
};

try {
  const v = await get('SELECT version() AS v, current_database() AS db');
  console.log('✔ Connected to', v.db, '—', v.v.split(',')[0]);
  await initSchema();
  console.log('✔ Tables are in place');
  const rows = await all(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`);
  console.log('  Tables:', rows.map((r) => r.table_name).join(', '));
  const { n } = await get('SELECT COUNT(*) AS n FROM users');
  console.log(`  Users: ${n}`);
  console.log('\nAll good. You can start the site with: npm start');
} catch (err) {
  console.error('✘ Could not use the database:', err.message);
  console.error('  →', hint(err));
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

function database(connectionString) {
  const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000 });
  pool.on('error', () => { /* Each request reports unavailable storage without logging credentials. */ });
  return {
    pool,
    async migrate() {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock(782126)');
        await c.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
        await c.query('COMMIT');
      } catch (error) { await c.query('ROLLBACK'); throw error; }
      finally { c.release(); }
    },
    async transaction(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        // One operational company: serialize postings, recipe changes and approvals.
        // Protects multi-row invariants and prevents a count racing a receipt.
        await c.query('SELECT pg_advisory_xact_lock(782127)');
        const result = await fn(c);
        await c.query('COMMIT');
        return result;
      } catch (error) { await c.query('ROLLBACK'); throw error; }
      finally { c.release(); }
    },
    close: () => pool.end()
  };
}
module.exports = { database };

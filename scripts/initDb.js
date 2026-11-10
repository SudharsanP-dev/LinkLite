/**
 * Creates the database (if needed) and the "urls" table.
 * Usage:  npm run db:init
 *
 * Needs a login that is allowed to create databases (for example "sa").
 * If you already ran database/schema.sql in SSMS, you don't need this.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const { buildConfig } = require('../config/db');

(async () => {
  const cfg = buildConfig();

  // schema.sql uses SSMS "GO" separators. Split into batches and drop the
  // CREATE DATABASE / USE batches, which are handled below.
  const batches = fs
    .readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8')
    .replace(/^\s*--.*$/gm, '')
    .split(/^\s*GO\s*$/im)
    .map((b) => b.trim())
    .filter((b) => b && !/^(IF DB_ID|USE\b)/i.test(b));

  try {
    // With a hosted connection string the database already exists.
    if (typeof cfg === 'object') {
      if (!/^[A-Za-z0-9_]+$/.test(cfg.database)) {
        throw new Error('DB_NAME may only contain letters, numbers and underscores.');
      }
      const master = await new sql.ConnectionPool({ ...cfg, database: 'master' }).connect();
      await master.request().batch(`IF DB_ID(N'${cfg.database}') IS NULL CREATE DATABASE [${cfg.database}]`);
      await master.close();
    }

    const pool = await new sql.ConnectionPool(cfg).connect();
    for (const batch of batches) await pool.request().batch(batch);
    await pool.close();

    console.log('Database is ready. Start the app with: npm run dev');
  } catch (err) {
    console.error('Could not set up the database:', err.message);
    console.error('Check the DB_* values in your .env file and that SQL Server is running.');
    process.exit(1);
  }
})();

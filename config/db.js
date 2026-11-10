const sql = require('mssql');

/**
 * Builds connection settings from environment variables.
 * Returns a connection string (hosted) or a config object (local).
 */
function buildConfig() {
  if (process.env.DB_CONNECTION_STRING) return process.env.DB_CONNECTION_STRING;

  const config = {
    server: process.env.DB_SERVER || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'linklite',
    options: {
      encrypt: process.env.DB_ENCRYPT === 'true',
      trustServerCertificate: process.env.DB_TRUST_CERT !== 'false',
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  };

  if (process.env.DB_INSTANCE) {
    // Named instance (e.g. SQLEXPRESS). Needs the "SQL Server Browser" service running.
    config.options.instanceName = process.env.DB_INSTANCE;
  } else {
    config.port = Number(process.env.DB_PORT) || 1433;
  }
  return config;
}

/** Creates and connects the shared connection pool. */
async function connect() {
  const pool = new sql.ConnectionPool(buildConfig());
  pool.on('error', (err) => console.error('SQL Server pool error:', err.message));
  await pool.connect();
  return pool;
}

module.exports = { sql, buildConfig, connect };

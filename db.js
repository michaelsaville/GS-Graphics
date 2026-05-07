const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  host:     config.db.host,
  port:     config.db.port,
  database: config.db.database,
  user:     config.db.user,
  password: config.db.password,
});

pool.on('error', (err) => {
  console.error('Unexpected PG pool error:', err);
});

const query = (text, params) => pool.query(text, params);

module.exports = { pool, query };

#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({
  host:     config.db.host,
  port:     config.db.port,
  database: config.db.database,
  user:     config.db.user,
  password: config.db.password,
});

const SQL = `
-- DB-stored admin password hash. Takes priority over the env hash when set, so
-- the operator can change their password from /admin/settings without editing .env.
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS admin_password_hash VARCHAR(255) DEFAULT '';
`;

async function migrate() {
  try {
    console.log('Running migration 012: admin password hash on site_settings ...');
    await pool.query(SQL);
    console.log('Migration 012 complete.');
  } catch (err) {
    console.error('Migration 012 failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

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
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS smtp_host    VARCHAR(255) DEFAULT '';
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS smtp_port    INT          DEFAULT 587;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS smtp_user    VARCHAR(255) DEFAULT '';
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS smtp_pass    VARCHAR(512) DEFAULT '';
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS smtp_from    VARCHAR(255) DEFAULT '';
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS smtp_secure  BOOLEAN      DEFAULT false;
`;

async function migrate() {
  try {
    console.log('Running migration 008: SMTP columns on site_settings ...');
    await pool.query(SQL);
    console.log('Migration 008 complete.');
  } catch (err) {
    console.error('Migration 008 failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

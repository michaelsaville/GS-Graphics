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
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS square_environment   VARCHAR(20)  DEFAULT 'sandbox';
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS square_access_token  VARCHAR(512) DEFAULT '';
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS square_location_id   VARCHAR(64)  DEFAULT '';
`;

async function migrate() {
  try {
    console.log('Running migration 009: Square columns on site_settings ...');
    await pool.query(SQL);
    console.log('Migration 009 complete.');
  } catch (err) {
    console.error('Migration 009 failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

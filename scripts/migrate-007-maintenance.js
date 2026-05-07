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
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS maintenance_enabled BOOLEAN DEFAULT false;
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS maintenance_message TEXT DEFAULT 'We''re briefly offline for updates. Please check back shortly.';
`;

async function migrate() {
  try {
    console.log('Running migration 007: maintenance mode ...');
    await pool.query(SQL);
    console.log('Migration 007 complete.');
  } catch (err) {
    console.error('Migration 007 failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

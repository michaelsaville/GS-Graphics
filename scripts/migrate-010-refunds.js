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
-- Square refund metadata. Populated when /admin/orders/:id/refund flips the order to refunded.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_id     VARCHAR(255) DEFAULT '';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at   TIMESTAMPTZ;
`;

async function migrate() {
  try {
    console.log('Running migration 010: order refund metadata ...');
    await pool.query(SQL);
    console.log('Migration 010 complete.');
  } catch (err) {
    console.error('Migration 010 failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

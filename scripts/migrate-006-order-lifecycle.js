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
-- Widen status vocabulary. Existing values (pending, paid, failed) remain valid.
-- New values: processing, ready, fulfilled, cancelled, refunded.
-- Status is still a free-form VARCHAR; we enforce vocabulary in app code.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS admin_notes TEXT DEFAULT '';

-- Per-order audit log of status changes (and notes added without status change).
CREATE TABLE IF NOT EXISTS order_status_log (
  id          SERIAL PRIMARY KEY,
  order_id    INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status VARCHAR(50) DEFAULT '',
  to_status   VARCHAR(50) NOT NULL,
  note        TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_status_log_order ON order_status_log (order_id, created_at);

-- Per-store order deadline. NULL = no deadline (always open while active).
ALTER TABLE stores ADD COLUMN IF NOT EXISTS orders_close_at        TIMESTAMPTZ;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS order_deadline_message VARCHAR(255) DEFAULT '';
`;

async function migrate() {
  try {
    console.log('Running migration 006: order lifecycle + store deadline ...');
    await pool.query(SQL);
    console.log('Migration 006 complete.');
  } catch (err) {
    console.error('Migration 006 failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

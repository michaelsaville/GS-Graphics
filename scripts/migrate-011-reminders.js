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
-- Idempotency for pickup reminders: when set, the cron skips this order.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_reminder_sent_at TIMESTAMPTZ;

-- How many hours before a pickup event to send reminders. Configurable per shop.
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS pickup_reminder_hours INT DEFAULT 24;

-- Cron secret for /api/cron/* endpoints (so the cron job is authenticated).
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS cron_secret VARCHAR(128) DEFAULT '';
`;

async function migrate() {
  try {
    console.log('Running migration 011: pickup reminders ...');
    await pool.query(SQL);
    // Generate a cron secret if none is set
    const cur = await pool.query('SELECT cron_secret FROM site_settings WHERE id = 1');
    if (!cur.rows[0] || !cur.rows[0].cron_secret) {
      const secret = require('crypto').randomBytes(32).toString('hex');
      await pool.query('UPDATE site_settings SET cron_secret = $1 WHERE id = 1', [secret]);
      console.log(`Generated cron_secret: ${secret}`);
      console.log('(Used by cron-triggered endpoints. Visible/regeneratable in admin.)');
    }
    console.log('Migration 011 complete.');
  } catch (err) {
    console.error('Migration 011 failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

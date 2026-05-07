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
-- Square order id (returned from createPaymentLink). Used to verify payment status server-side
-- on /checkout/callback instead of trusting the redirect query param.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS square_order_id VARCHAR(255) DEFAULT '';
`;

async function migrate() {
  try {
    console.log('Running migration 004: orders.square_order_id ...');
    await pool.query(SQL);
    console.log('Migration 004 complete.');
  } catch (err) {
    console.error('Migration 004 failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

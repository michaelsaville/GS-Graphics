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
-- Store-level personalization pricing (name and number priced independently)
ALTER TABLE stores ADD COLUMN IF NOT EXISTS personalization_name_price  NUMERIC(8,2) DEFAULT 0.00;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS personalization_number_price NUMERIC(8,2) DEFAULT 0.00;

-- Store-level sales tax rate (default 6%)
ALTER TABLE stores ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(5,4) DEFAULT 0.0600;

-- Track tax on orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(10,2) DEFAULT 0.00;

-- Drop item-level personalization_upcharge (now handled at store level)
ALTER TABLE items DROP COLUMN IF EXISTS personalization_upcharge;
`;

async function migrate() {
  try {
    console.log('Running migration 002: store-level personalization + tax ...');
    await pool.query(SQL);
    console.log('Migration 002 complete.');
  } catch (err) {
    console.error('Migration 002 failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

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
-- Shop-wide defaults (single row)
CREATE TABLE IF NOT EXISTS shop_defaults (
  id                          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  default_tax_rate            NUMERIC(5,4) DEFAULT 0.0600,
  default_personalization_name_price  NUMERIC(8,2) DEFAULT 0.00,
  default_personalization_number_price NUMERIC(8,2) DEFAULT 0.00
);

-- Insert the single defaults row if it doesn't exist
INSERT INTO shop_defaults (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Default size template (copied into store_sizes when a new store is created)
CREATE TABLE IF NOT EXISTS default_sizes (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(20) NOT NULL,
  price_modifier NUMERIC(8,2) DEFAULT 0.00,
  sort_order     INT DEFAULT 0
);
`;

// Standard decorated apparel sizes
const SEED_SIZES = [
  { name: 'YS',  modifier: 0,    order: 1 },
  { name: 'YM',  modifier: 0,    order: 2 },
  { name: 'YL',  modifier: 0,    order: 3 },
  { name: 'S',   modifier: 0,    order: 4 },
  { name: 'M',   modifier: 0,    order: 5 },
  { name: 'L',   modifier: 0,    order: 6 },
  { name: 'XL',  modifier: 0,    order: 7 },
  { name: '2XL', modifier: 2.00, order: 8 },
  { name: '3XL', modifier: 3.00, order: 9 },
  { name: '4XL', modifier: 4.00, order: 10 },
];

async function migrate() {
  try {
    console.log('Running migration 003: shop defaults + default sizes ...');
    await pool.query(SQL);

    // Only seed if table is empty
    const existing = await pool.query('SELECT COUNT(*) as count FROM default_sizes');
    if (parseInt(existing.rows[0].count) === 0) {
      console.log('Seeding default size template...');
      for (const s of SEED_SIZES) {
        await pool.query(
          'INSERT INTO default_sizes (name, price_modifier, sort_order) VALUES ($1, $2, $3)',
          [s.name, s.modifier, s.order]
        );
      }
      console.log(`Seeded ${SEED_SIZES.length} default sizes.`);
    } else {
      console.log('Default sizes already exist, skipping seed.');
    }

    console.log('Migration 003 complete.');
  } catch (err) {
    console.error('Migration 003 failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

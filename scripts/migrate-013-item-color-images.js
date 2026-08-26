#!/usr/bin/env node
// Migration 013: give each colorway its own product photo.
//
// Until now `item_colors` carried only a name, a hex swatch and a sort order,
// so an item could show exactly ONE photo no matter how many colorways it had.
// A shopper choosing "Grey" saw the black garment. That was survivable on the
// CBMS "Grind to Win" tee (one item, two colors) and was consciously left
// alone, but the Keyser Lady Tornado store has two colorways on all four items
// and colour is one of only two choices a shopper makes there.
//
// image_url is nullable-by-default (''), and the item page falls back to
// items.image_url when a colour has no photo of its own — so every existing
// item keeps rendering exactly as it did before this ran.
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
-- Per-colorway product photo. Empty string means "fall back to items.image_url".
ALTER TABLE item_colors ADD COLUMN IF NOT EXISTS image_url VARCHAR(512) DEFAULT '';
`;

async function migrate() {
  try {
    console.log('Running migration 013: per-colorway product images ...');
    await pool.query(SQL);

    const check = await pool.query(`
      SELECT column_name, data_type, column_default
        FROM information_schema.columns
       WHERE table_name = 'item_colors' AND column_name = 'image_url'
    `);
    if (!check.rows[0]) throw new Error('image_url column missing after ALTER');
    console.log(`  item_colors.image_url ${check.rows[0].data_type}, default ${check.rows[0].column_default}`);

    const counts = await pool.query(`
      SELECT count(*) AS total,
             count(*) FILTER (WHERE image_url <> '') AS with_image
        FROM item_colors
    `);
    console.log(`  ${counts.rows[0].total} colorways, ${counts.rows[0].with_image} with their own photo.`);
    console.log('Migration 013 complete.');
  } catch (err) {
    console.error('Migration 013 failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

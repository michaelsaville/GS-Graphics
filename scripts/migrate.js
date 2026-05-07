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
-- connect-pg-simple session table
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    VARCHAR NOT NULL PRIMARY KEY,
  "sess"   JSON    NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- Stores (campaigns)
CREATE TABLE IF NOT EXISTS stores (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  slug        VARCHAR(255) NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  image_url   VARCHAR(512) DEFAULT '',
  active      BOOLEAN DEFAULT false,
  personalization_name_price  NUMERIC(8,2) DEFAULT 0.00,
  personalization_number_price NUMERIC(8,2) DEFAULT 0.00,
  tax_rate    NUMERIC(5,4) DEFAULT 0.0600,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Global size definitions per store (with price modifiers)
CREATE TABLE IF NOT EXISTS store_sizes (
  id             SERIAL PRIMARY KEY,
  store_id       INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name           VARCHAR(20) NOT NULL,
  price_modifier NUMERIC(8,2) DEFAULT 0.00,
  sort_order     INT DEFAULT 0
);

-- Items (products per store)
CREATE TABLE IF NOT EXISTS items (
  id                        SERIAL PRIMARY KEY,
  store_id                  INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name                      VARCHAR(255) NOT NULL,
  description               TEXT DEFAULT '',
  image_url                 VARCHAR(512) DEFAULT '',
  base_price                NUMERIC(8,2) NOT NULL DEFAULT 0.00,
  personalization_enabled   BOOLEAN DEFAULT false,
  active                    BOOLEAN DEFAULT true,
  sort_order                INT DEFAULT 0,
  created_at                TIMESTAMPTZ DEFAULT NOW()
);

-- Item color options
CREATE TABLE IF NOT EXISTS item_colors (
  id         SERIAL PRIMARY KEY,
  item_id    INT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  name       VARCHAR(100) NOT NULL,
  hex_code   VARCHAR(7) DEFAULT '#000000',
  sort_order INT DEFAULT 0
);

-- Pickup events per store
CREATE TABLE IF NOT EXISTS pickup_events (
  id         SERIAL PRIMARY KEY,
  store_id   INT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name       VARCHAR(255) NOT NULL,
  event_date DATE NOT NULL,
  event_time VARCHAR(50) DEFAULT '',
  location   VARCHAR(255) DEFAULT ''
);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
  id                SERIAL PRIMARY KEY,
  store_id          INT NOT NULL REFERENCES stores(id) ON DELETE SET NULL,
  pickup_event_id   INT REFERENCES pickup_events(id) ON DELETE SET NULL,
  customer_name     VARCHAR(255) NOT NULL,
  customer_email    VARCHAR(255) DEFAULT '',
  customer_phone    VARCHAR(50) DEFAULT '',
  customer_cell     VARCHAR(50) DEFAULT '',
  customer_address  VARCHAR(255) DEFAULT '',
  customer_city     VARCHAR(100) DEFAULT '',
  customer_state    VARCHAR(50) DEFAULT '',
  customer_zip      VARCHAR(20) DEFAULT '',
  square_payment_id VARCHAR(255) DEFAULT '',
  status            VARCHAR(50) DEFAULT 'pending',
  total_amount      NUMERIC(10,2) DEFAULT 0.00,
  tax_amount        NUMERIC(10,2) DEFAULT 0.00,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Order line items
CREATE TABLE IF NOT EXISTS order_items (
  id                     SERIAL PRIMARY KEY,
  order_id               INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id                INT REFERENCES items(id) ON DELETE SET NULL,
  item_name              VARCHAR(255) NOT NULL,
  color_name             VARCHAR(100) DEFAULT '',
  size_name              VARCHAR(20) DEFAULT '',
  quantity               INT NOT NULL DEFAULT 1,
  unit_price             NUMERIC(8,2) NOT NULL DEFAULT 0.00,
  personalization_name   VARCHAR(255) DEFAULT '',
  personalization_number VARCHAR(50) DEFAULT ''
);

-- Shop-wide defaults (single row)
CREATE TABLE IF NOT EXISTS shop_defaults (
  id                          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  default_tax_rate            NUMERIC(5,4) DEFAULT 0.0600,
  default_personalization_name_price  NUMERIC(8,2) DEFAULT 0.00,
  default_personalization_number_price NUMERIC(8,2) DEFAULT 0.00
);
INSERT INTO shop_defaults (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Default size template
CREATE TABLE IF NOT EXISTS default_sizes (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(20) NOT NULL,
  price_modifier NUMERIC(8,2) DEFAULT 0.00,
  sort_order     INT DEFAULT 0
);
`;

async function migrate() {
  try {
    console.log('Running migrations on', config.db.database, '...');
    await pool.query(SQL);
    console.log('Migrations complete.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

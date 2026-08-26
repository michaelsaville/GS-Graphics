#!/usr/bin/env node
// Seed the Keyser Middle School Volleyball store.
//
// Source of truth: Jentry Shanholtz, "Keyser Middle School Volleyball Store"
// (2026-08-25 14:52 ET, greenspringgraphics@gmail.com). The message is short
// enough to quote in full — this is the ENTIRE spec:
//
//   T's - $10
//   Long Sleeves - $13
//   Crewnecks - $17
//   Hoodies - $20
//   Sizes YXS-YXL, S-5XL
//   $3 more for 2XL-5XL
//   Add a customization option for name and number +$5
//
// ...plus 8 mockups: 4 garments x 2 colorways (Black, Grey).
//
// 🚨 THIS STORE IS NOT CBMS. Do not carry the Capon Bridge rules across —
// they are inverted here on all three counts:
//   - CBMS has NO size upcharges; this store charges +$3.00 on 2XL-5XL.
//   - CBMS has personalization OFF; this store has it ON (name + number).
//   - CBMS runs YS-4XL; this store runs YXS-YXL and S-5XL (5XL is new).
//
// Idempotent: upserts the store by slug and items by (store_id, name).
// `upsertItem`'s UPDATE never touches image_url, so a re-run does not clobber
// product photos that were loaded after the fact.

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

const STORE_SLUG = 'kms-volleyball-2026';

// Straight from Jentry's 2026-08-25 message. Do not "round" these.
const PRICE = {
  tee:        10.00,
  longsleeve: 13.00,
  crewneck:   17.00,
  hoodie:     20.00,
};

// "Sizes YXS-YXL, S-5XL / $3 more for 2XL-5XL".
//
// Note this is a FLAT $3.00 across 2XL-5XL — it is neither the CBMS flat-zero
// nor the house `default_sizes` ladder (2XL +$2 / 3XL +$3 / 4XL +$4). 5XL does
// not exist in `default_sizes` at all; it is introduced here.
const SIZES = [
  { name: 'YXS', price_modifier: 0.00, sort_order: 1 },
  { name: 'YS',  price_modifier: 0.00, sort_order: 2 },
  { name: 'YM',  price_modifier: 0.00, sort_order: 3 },
  { name: 'YL',  price_modifier: 0.00, sort_order: 4 },
  { name: 'YXL', price_modifier: 0.00, sort_order: 5 },
  { name: 'S',   price_modifier: 0.00, sort_order: 6 },
  { name: 'M',   price_modifier: 0.00, sort_order: 7 },
  { name: 'L',   price_modifier: 0.00, sort_order: 8 },
  { name: 'XL',  price_modifier: 0.00, sort_order: 9 },
  { name: '2XL', price_modifier: 3.00, sort_order: 10 },
  { name: '3XL', price_modifier: 3.00, sort_order: 11 },
  { name: '4XL', price_modifier: 3.00, sort_order: 12 },
  { name: '5XL', price_modifier: 3.00, sort_order: 13 },
];

// ⚠ ASSUMPTION FLAGGED FOR JENTRY. He wrote "Add a customization option for
// name and number +$5" as a single line, so the pair costs $5.
//
// `routes/store.js` prices name and number INDEPENDENTLY (it adds
// personalization_name_price only if a name was typed, and
// personalization_number_price only if a number was typed). There is no way to
// express "$5 for the pair" as one number, so the $5 is split 3/2 — which is
// also the existing house split. Consequences:
//   name + number = $5.00  <- matches what he wrote
//   name only     = $3.00
//   number only   = $2.00
// If he actually meant $5 EACH, set both prices to 5.00 and re-run.
const PERSONALIZATION = { name: 3.00, number: 2.00 };

// Two colorways on every item, per the 8 mockups (Black + Grey of each garment).
//
// ⚠ The grey hex below is a placeholder. CBMS's graphite swatch was sampled
// from the actual JPEG; the Keyser photos are not on this box yet, so this is a
// generic sport-grey. Re-sample it from KMS_*_Grey.jpg once the photos land.
const COLORS = [
  { name: 'Black', hex_code: '#000000', sort_order: 1 },
  { name: 'Grey',  hex_code: '#9EA2A2', sort_order: 2 },
];

// Expected upload filenames. The script writes image_url ON INSERT ONLY, so
// dropping these into /app/public/uploads with these exact names is all that is
// needed. See the console output at the end of a run for the docker cp recipe.
//
// ⚠ Only ONE photo per item can be shown: `item_colors` has no image column, so
// the four KMS_*_Grey.jpg files have nowhere to render. Black is used as the
// primary because it is the first colorway. This is the same known gap that
// affects the CBMS "Grind to Win" tee, except here it hits every item.
const GARMENTS = [
  {
    key: 'tee',
    label: 'T-Shirt',
    price: PRICE.tee,
    image: '/uploads/kms-volleyball-tshirt.jpg',
    sort_order: 10,
    blurb: 'A soft, everyday cotton tee with the Keyser volleyball design printed on the front. ' +
           'Light enough for warm-ups and school days, and it holds its color wash after wash.',
  },
  {
    key: 'longsleeve',
    label: 'Long Sleeve T-Shirt',
    price: PRICE.longsleeve,
    image: '/uploads/kms-volleyball-longsleeve.jpg',
    sort_order: 20,
    blurb: 'The same team design on a long sleeve cotton tee. A good layer for cool mornings, ' +
           'chilly bleachers, and practices once the season turns.',
  },
  {
    key: 'crewneck',
    label: 'Crewneck Sweatshirt',
    price: PRICE.crewneck,
    image: '/uploads/kms-volleyball-crewneck.jpg',
    sort_order: 30,
    blurb: 'A classic fleece crewneck with the team design across the chest. Warm, roomy, ' +
           'and easy to pull on over a jersey or a school shirt.',
  },
  {
    key: 'hoodie',
    label: 'Hoodie',
    price: PRICE.hoodie,
    image: '/uploads/kms-volleyball-hoodie.jpg',
    sort_order: 40,
    blurb: 'A heavyweight hooded sweatshirt with a front pouch pocket and the team design ' +
           'on the chest. The warmest piece in the store and the one that gets worn all season.',
  },
];

const STORE_LINE =
  'Volleyball spirit wear for Keyser Middle School players, parents, and fans.';

function buildItems() {
  return GARMENTS.map(g => ({
    name: `Keyser Volleyball ${g.label}`,
    base_price: g.price,
    sort_order: g.sort_order,
    personalization_enabled: true,
    image_url: g.image,
    description:
      `${STORE_LINE} ${g.blurb} Available in black and grey, and you can add a player ` +
      `name and number on the back. Printed locally by Green Spring Graphics.`,
    colors: COLORS,
  }));
}

async function upsertStore(client) {
  const res = await client.query(
    `INSERT INTO stores (name, slug, description, active,
                         personalization_name_price, personalization_number_price, tax_rate)
     VALUES ($1, $2, $3, false, $4, $5, 0.0600)
     ON CONFLICT (slug) DO UPDATE
       SET name = EXCLUDED.name,
           description = EXCLUDED.description,
           personalization_name_price = EXCLUDED.personalization_name_price,
           personalization_number_price = EXCLUDED.personalization_number_price,
           tax_rate = EXCLUDED.tax_rate,
           updated_at = now()
     RETURNING id`,
    ['Keyser Middle School Volleyball', STORE_SLUG, STORE_LINE,
     PERSONALIZATION.name, PERSONALIZATION.number]
  );
  return res.rows[0].id;
}

async function replaceSizes(client, storeId) {
  await client.query('DELETE FROM store_sizes WHERE store_id = $1', [storeId]);
  for (const s of SIZES) {
    await client.query(
      'INSERT INTO store_sizes (store_id, name, price_modifier, sort_order) VALUES ($1,$2,$3,$4)',
      [storeId, s.name, s.price_modifier, s.sort_order]
    );
  }
}

async function upsertItem(client, storeId, item) {
  // No unique constraint on (store_id, name), so look up then insert/update.
  const found = await client.query(
    'SELECT id FROM items WHERE store_id = $1 AND name = $2',
    [storeId, item.name]
  );

  let itemId;
  if (found.rows[0]) {
    itemId = found.rows[0].id;
    // image_url deliberately absent: a re-run must not clobber a photo that was
    // uploaded or swapped in /admin after the initial seed.
    await client.query(
      `UPDATE items SET description = $1, base_price = $2,
              personalization_enabled = $3, sort_order = $4, active = true
       WHERE id = $5`,
      [item.description, item.base_price, item.personalization_enabled, item.sort_order, itemId]
    );
  } else {
    const ins = await client.query(
      `INSERT INTO items (store_id, name, description, base_price,
                          personalization_enabled, sort_order, active, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7) RETURNING id`,
      [storeId, item.name, item.description, item.base_price,
       item.personalization_enabled, item.sort_order, item.image_url]
    );
    itemId = ins.rows[0].id;
  }

  await client.query('DELETE FROM item_colors WHERE item_id = $1', [itemId]);
  for (const c of item.colors) {
    await client.query(
      'INSERT INTO item_colors (item_id, name, hex_code, sort_order) VALUES ($1,$2,$3,$4)',
      [itemId, c.name, c.hex_code, c.sort_order]
    );
  }
  return itemId;
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const storeId = await upsertStore(client);
    await replaceSizes(client, storeId);

    const items = buildItems();
    for (const item of items) {
      await upsertItem(client, storeId, item);
    }

    await client.query('COMMIT');

    console.log(`Seeded "${STORE_SLUG}" (store id ${storeId}) — ${items.length} items, ${SIZES.length} sizes.`);
    console.log('');
    console.log('Store is seeded active=false (preview). Open it in /admin when ready.');
    console.log('orders_close_at is NOT set — Jentry has not given a cutoff date.');
    console.log('');
    console.log('Photos still needed. Export the 8 attachments from his 2026-08-25');
    console.log('email, then (Black is the primary; Grey has nowhere to render yet):');
    console.log('  docker cp KMS_T-Shirt_Black.jpg   gs-graphics-app:/app/public/uploads/kms-volleyball-tshirt.jpg');
    console.log('  docker cp KMS_LongSleeve_Black.jpg gs-graphics-app:/app/public/uploads/kms-volleyball-longsleeve.jpg');
    console.log('  docker cp KMS_Crewneck_Black.jpg   gs-graphics-app:/app/public/uploads/kms-volleyball-crewneck.jpg');
    console.log('  docker cp KMS_Hoodie_Black.jpg     gs-graphics-app:/app/public/uploads/kms-volleyball-hoodie.jpg');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed, rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();

// OPEN QUESTIONS FOR JENTRY (none of these block the build):
//   1. Personalization price. "+$5" is split 3/2 across name/number so the pair
//      costs $5. Confirm he did not mean $5 each.
//   2. Cutoff date. orders_close_at is NULL. He still owes a date for CBMS too.
//   3. Pickup event. No pickup date/location was given; none is seeded.
//   4. Grey swatch hex is a placeholder until the photos are sampled.
//
// CONFIRMED, do not re-ask:
//   - Tax 6% (Michael, 2026-08-26).

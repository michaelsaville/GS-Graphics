#!/usr/bin/env node
// Seed the Capon Bridge Middle School (CBMS) team stores.
//
// Source of truth: Jentry Shanholtz thread "Capon Bridge Middle School Store"
// (2026-08-19 .. 2026-08-21). Pricing came in the 2026-08-21 message:
//   All t's $15 · Shorts $13 · Sweatpants $22 · Long Sleeves $18
//   Crewneck Sweatshirts $22 · Hoodies $30 · Bags $28
//
// Idempotent: re-running upserts stores/items by slug/name rather than
// duplicating. `upsertItem`'s UPDATE never touches image_url, so a re-run does
// not clobber the loaded product photos.
//
// Sizes, personalization and colors were all confirmed by Jentry on 2026-08-24
// and are baked in below — no house defaults remain. The one thing this script
// does NOT set is orders_close_at: Jentry wants roughly a two-week run but has
// not named a cutoff date yet, so the deadline is managed in /admin.

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

// Prices straight from Jentry's 2026-08-21 message. Do not "round" these.
const PRICE = {
  tee:        15.00,
  longsleeve: 18.00,
  crewneck:   22.00,
  hoodie:     30.00,
  sweatpants: 22.00,
  shorts:     13.00,
  bag:        28.00,
};

// Apparel size run. CONFIRMED by Jentry 2026-08-24: "Keep those sizes, but no
// upcharges. We're going to run them all the same price and I'm giving the
// school $5 from every sale and I'll eat the oversized charges." Every modifier
// is 0.00 on purpose — do not restore the house `default_sizes` 2XL/3XL/4XL
// ladder here.
const APPAREL_SIZES = [
  { name: 'YS',  price_modifier: 0.00, sort_order: 1 },
  { name: 'YM',  price_modifier: 0.00, sort_order: 2 },
  { name: 'YL',  price_modifier: 0.00, sort_order: 3 },
  { name: 'S',   price_modifier: 0.00, sort_order: 4 },
  { name: 'M',   price_modifier: 0.00, sort_order: 5 },
  { name: 'L',   price_modifier: 0.00, sort_order: 6 },
  { name: 'XL',  price_modifier: 0.00, sort_order: 7 },
  { name: '2XL', price_modifier: 0.00, sort_order: 8 },
  { name: '3XL', price_modifier: 0.00, sort_order: 9 },
  { name: '4XL', price_modifier: 0.00, sort_order: 10 },
];

// Personalization: OFF on every item. Jentry 2026-08-24: "Names and numbers —
// No personalization on any of this. That's just the art that he sent me with
// that ribbon at the bottom but we left it all empty." The empty banner ribbon
// under each sport crest is part of the artwork, not a name slot. These store
// columns are NOT NULL, so the prices below are inert placeholders — every item
// carries personalization_enabled: false, which is what actually gates the UI.
const PERSONALIZATION = { name: 3.00, number: 2.00 };

// Garment copy is written once and reused across sports; the sport line is what
// changes. Keeps voice consistent across 20-odd items without 20 hand-written
// blurbs drifting apart.
const GARMENT = {
  tee: {
    label: 'T-Shirt',
    price: PRICE.tee,
    blurb: 'A soft, everyday cotton tee with the team design printed on the front. ' +
           'Light enough for warm-ups and school days, and it holds its color wash after wash.',
  },
  longsleeve: {
    label: 'Long Sleeve T-Shirt',
    price: PRICE.longsleeve,
    blurb: 'The same team design on a long sleeve cotton tee. A good layer for cool mornings, ' +
           'chilly bleachers, and practices once the season turns.',
  },
  crewneck: {
    label: 'Crewneck Sweatshirt',
    price: PRICE.crewneck,
    blurb: 'A classic fleece crewneck with the team design across the chest. Warm, roomy, ' +
           'and easy to pull on over a jersey or a school shirt.',
  },
  hoodie: {
    label: 'Hoodie',
    price: PRICE.hoodie,
    blurb: 'A heavyweight hooded sweatshirt with a front pouch pocket and the team design ' +
           'on the chest. The warmest piece in the store and the one that gets worn all season.',
  },
};

const SPORTS = [
  {
    slug: 'cbms-football-2026',
    name: 'CBMS Football',
    tag: 'Football',
    line: 'Show your Capon Bridge Wildcats football pride in the stands and around school.',
  },
  {
    slug: 'cbms-cheer-2026',
    name: 'CBMS Cheer',
    tag: 'Cheer',
    line: 'Cheer squad spirit wear for Capon Bridge Wildcats athletes and their families.',
  },
  {
    slug: 'cbms-volleyball-2026',
    name: 'CBMS Volleyball',
    tag: 'Volleyball',
    line: 'Volleyball spirit wear for Capon Bridge Wildcats players, parents, and fans.',
  },
  {
    slug: 'cbms-cross-country-2026',
    name: 'CBMS Cross Country',
    tag: 'Cross Country',
    line: 'Cross country spirit wear for Capon Bridge Wildcats runners and the families cheering them on.',
  },
  {
    slug: 'cbms-golf-2026',
    name: 'CBMS Golf',
    tag: 'Golf',
    line: 'Golf team spirit wear for Capon Bridge Wildcats players and supporters.',
  },
];

function sportItems(sport) {
  const items = ['tee', 'longsleeve', 'crewneck', 'hoodie'].map((key, i) => {
    const g = GARMENT[key];
    return {
      name: `Capon Bridge ${sport.tag} ${g.label}`,
      base_price: g.price,
      sort_order: (i + 1) * 10,
      personalization_enabled: false,
      description:
        `${sport.line} ${g.blurb} Printed locally by Green Spring Graphics in Wildcats orange ` +
        `and white.`,
      colors: [],
    };
  });

  // Football got two extra mockups on 2026-08-19 — the same "Grind to Win" tee
  // in two colorways, so it is ONE item with two colors, not two items.
  if (sport.tag === 'Football') {
    items.push({
      name: 'Capon Bridge Football "Grind to Win" T-Shirt',
      base_price: PRICE.tee,
      sort_order: 15,
      personalization_enabled: false,
      description:
        'A two-sided team tee: the Wildcats paw on the left chest up front, and the ' +
        '"Grind to Win" helmet graphic across the back with the team motto — ' +
        'Together we grind. Together we win. Available in graphite heather and black.',
      colors: [
        { name: 'Graphite Heather', hex_code: '#858085', sort_order: 1 },
        { name: 'Black',            hex_code: '#000000', sort_order: 2 },
      ],
    });
  }
  return items;
}

// Sized, school-wide goods that are not tied to one sport.
const SPIRIT_STORE = {
  slug: 'cbms-spirit-wear-2026',
  name: 'CBMS Spirit Wear',
  description: 'School-wide Capon Bridge Middle School spirit wear — open to every student, ' +
               'family, and staff member, whatever team you cheer for.',
  sizes: APPAREL_SIZES,
  items: [
    {
      name: 'Capon Bridge Sweatpants',
      base_price: PRICE.sweatpants,
      sort_order: 10,
      personalization_enabled: false,
      description:
        'Comfortable fleece sweatpants with the Capon Bridge Wildcats design. ' +
        'An easy pick for practice, gym class, and cold mornings at the bus stop.',
      colors: [],
    },
    {
      name: 'Capon Bridge Shorts',
      base_price: PRICE.shorts,
      sort_order: 20,
      personalization_enabled: false,
      description:
        'Lightweight athletic shorts in black with the orange Wildcats paw on the leg. ' +
        'Built for practice, gym class, and everything in between.',
      colors: [],
    },
  ],
};

// Unsized goods live in their own store on purpose. `store_sizes` is store-wide,
// so a bag sharing a store with sweatpants would render a YS-4XL dropdown and a
// shopper picking "3XL" would be charged the +$3.00 size modifier on a one-size
// bag. Separate store = no size list = no phantom upcharge.
const ACCESSORY_STORE = {
  slug: 'cbms-accessories-2026',
  name: 'CBMS Bags & Accessories',
  description: 'One-size Capon Bridge Wildcats gear — no sizing needed.',
  sizes: [],
  items: [
    {
      name: 'Capon Bridge Wildcats Bag',
      base_price: PRICE.bag,
      sort_order: 10,
      personalization_enabled: false,
      description:
        'A Capon Bridge Wildcats bag for practice gear, cleats, and school books. ' +
        'One size — roomy enough for a full kit and easy to carry to the field.',
      colors: [],
    },
  ],
};

async function upsertStore(client, store) {
  const res = await client.query(
    `INSERT INTO stores (name, slug, description, active,
                         personalization_name_price, personalization_number_price, tax_rate)
     VALUES ($1, $2, $3, false, $4, $5, 0.0600)
     ON CONFLICT (slug) DO UPDATE
       SET name = EXCLUDED.name,
           description = EXCLUDED.description,
           personalization_name_price = EXCLUDED.personalization_name_price,
           personalization_number_price = EXCLUDED.personalization_number_price,
           updated_at = now()
     RETURNING id`,
    [store.name, store.slug, store.description,
     PERSONALIZATION.name, PERSONALIZATION.number]
  );
  return res.rows[0].id;
}

async function replaceSizes(client, storeId, sizes) {
  await client.query('DELETE FROM store_sizes WHERE store_id = $1', [storeId]);
  for (const s of sizes) {
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
    await client.query(
      `UPDATE items SET description = $1, base_price = $2,
              personalization_enabled = $3, sort_order = $4, active = true
       WHERE id = $5`,
      [item.description, item.base_price, item.personalization_enabled, item.sort_order, itemId]
    );
  } else {
    const ins = await client.query(
      `INSERT INTO items (store_id, name, description, base_price,
                          personalization_enabled, sort_order, active)
       VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id`,
      [storeId, item.name, item.description, item.base_price,
       item.personalization_enabled, item.sort_order]
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
  let stores = 0, items = 0;
  try {
    await client.query('BEGIN');

    for (const sport of SPORTS) {
      const storeId = await upsertStore(client, {
        slug: sport.slug,
        name: sport.name,
        description: sport.line,
      });
      await replaceSizes(client, storeId, APPAREL_SIZES);
      for (const item of sportItems(sport)) {
        await upsertItem(client, storeId, item);
        items++;
      }
      stores++;
      console.log(`  ${sport.name} (${sport.slug})`);
    }

    for (const store of [SPIRIT_STORE, ACCESSORY_STORE]) {
      const storeId = await upsertStore(client, store);
      await replaceSizes(client, storeId, store.sizes);
      for (const item of store.items) {
        await upsertItem(client, storeId, item);
        items++;
      }
      stores++;
      console.log(`  ${store.name} (${store.slug})`);
    }

    await client.query('COMMIT');
    console.log(`\nSeeded ${stores} stores / ${items} items.`);
    console.log('Store active/orders_close_at and item image_url are NOT touched by this');
    console.log('script — manage those in /admin. Sizes are flat (no upcharges) and');
    console.log('personalization is off on every item, per Jentry 2026-08-24.');
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

// NOTES — Jentry answered all four on 2026-08-24 ("Re: Capon Bridge Middle
// School Store"). Kept here so a future reader knows these are settled, not
// assumed:
//   1. Sizes. "Keep those sizes, but no upcharges." YS-4XL stays; every
//      price_modifier is 0.00. He is donating $5/sale to the school and
//      absorbing the oversized-garment cost himself.
//   2. Name/number personalization. "No personalization on any of this." The
//      empty banner ribbon under each sport crest is decorative artwork. Every
//      item is personalization_enabled: false.
//   3. Garment colors. "Grind to win shirts are the only ones that have
//      different color options." Confirmed correct as built — one item, two
//      item_colors rows. Everything else is single-color.
//      ⚠ STILL OPEN (a display bug, not a client question): item_colors has no
//      image column, so the Black colorway renders the graphite photo. The file
//      cbms-football-grind-to-win-black.jpg is uploaded but unreferenced.
//   4. Order deadline. He wants a cutoff — "a 2 week run or so and then open it
//      back up later for a second run" — but has NOT named the date. Left unset
//      deliberately; set orders_close_at per store once he does.

const express = require('express');
const router  = express.Router();
const db      = require('../db');
const siteSettings = require('../site-settings');
const { sendContactEmail } = require('../mailer');

// Cart lives in session: req.session.cart = [{ itemId, itemName, colorId, colorName, sizeId, sizeName, quantity, unitPrice, personalizationName, personalizationNumber, storeId, storeSlug }]

function getCart(req) {
  if (!req.session.cart) req.session.cart = [];
  return req.session.cart;
}

// A store is "open" for orders when active AND not past its deadline.
function isStoreOpen(store) {
  if (!store || !store.active) return false;
  if (!store.orders_close_at) return true;
  return new Date() < new Date(store.orders_close_at);
}
module.exports.isStoreOpen = isStoreOpen;

// ─── Dynamic favicon (SVG) ────────────────────────────────────────────────────
// Generated from current brand color + first letter of brand name. Cache for 1h.
router.get('/favicon.svg', async (req, res) => {
  const settings = await siteSettings.load();
  const color = settings.brand.color || '#2e7d32';
  const letter = ((settings.brand.name || 'G').trim()[0] || 'G').toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="6" fill="${color}"/>
  <text x="16" y="22" font-family="-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif" font-size="20" font-weight="700" fill="#fff" text-anchor="middle">${letter.replace(/[<>&]/g, '')}</text>
</svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(svg);
});

// ─── Privacy Policy ───────────────────────────────────────────────────────────
router.get('/privacy', (req, res) => {
  res.render('store/privacy', { title: 'Privacy Policy', cart: getCart(req) });
});

// ─── Order tracking (self-serve) ──────────────────────────────────────────────
// Customer enters email + order #. We never reveal which half is wrong, just
// "no order found matching those details." Reduces enumeration risk.
router.get('/track', (req, res) => {
  res.render('store/track', { title: 'Track Your Order', cart: getCart(req), result: null, query: { order_id: '', email: '' } });
});

router.post('/track', async (req, res) => {
  const orderId = parseInt(req.body.order_id);
  const email = (req.body.email || '').trim().toLowerCase();

  let order = null, items = [], log = [];
  if (Number.isFinite(orderId) && email) {
    const result = await db.query(
      `SELECT o.*, s.name as store_name, pe.name as event_name, pe.event_date, pe.event_time, pe.location as event_location
       FROM orders o LEFT JOIN stores s ON o.store_id = s.id
       LEFT JOIN pickup_events pe ON o.pickup_event_id = pe.id
       WHERE o.id = $1 AND LOWER(o.customer_email) = $2`,
      [orderId, email]
    );
    if (result.rows[0]) {
      order = result.rows[0];
      const itemsResult = await db.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
      items = itemsResult.rows;
      const logResult = await db.query(
        'SELECT to_status, created_at FROM order_status_log WHERE order_id = $1 AND from_status <> to_status ORDER BY created_at',
        [orderId]
      );
      log = logResult.rows;
    }
  }

  res.render('store/track', {
    title: 'Track Your Order',
    cart: getCart(req),
    result: { order, items, log, found: Boolean(order) },
    query: { order_id: req.body.order_id || '', email: req.body.email || '' },
  });
});

// ─── Contact Us ───────────────────────────────────────────────────────────────
router.get('/contact', (req, res) => {
  res.render('store/contact', { title: 'Contact Us', cart: getCart(req), submitted: false });
});

router.post('/contact', async (req, res) => {
  // Honeypot: real users can't see this field. Bots that bulk-fill trip it.
  // Silently accept (return success) so they don't realize they were filtered.
  if (req.body.website && String(req.body.website).trim() !== '') {
    return res.render('store/contact', { title: 'Thanks', cart: getCart(req), submitted: true });
  }

  // Per-session rate limit: 1 submission per 60 seconds.
  const now = Date.now();
  const last = req.session.lastContactSubmitAt || 0;
  if (now - last < 60_000) {
    req.session.flash = { type: 'error', message: 'Please wait a moment before sending another message.' };
    return res.redirect('/contact');
  }

  const name    = (req.body.name    || '').trim().slice(0, 200);
  const email   = (req.body.email   || '').trim().slice(0, 200);
  const message = (req.body.message || '').trim().slice(0, 5000);

  if (!name || !email || !message) {
    req.session.flash = { type: 'error', message: 'Please fill in all fields.' };
    return res.redirect('/contact');
  }

  req.session.lastContactSubmitAt = now;

  // Always persist first so nothing is lost regardless of email delivery
  const inserted = await db.query(
    `INSERT INTO contact_submissions (name, email, message, email_status)
     VALUES ($1, $2, $3, 'pending') RETURNING id`,
    [name, email, message]
  );
  const submissionId = inserted.rows[0].id;

  // Best-effort email send to the configured recipient
  const settings = await siteSettings.load();
  const recipient = settings.site.contactRecipient;

  const result = await sendContactEmail({
    to: recipient,
    fromEmail: email,
    fromName: name,
    subject: `Contact form: ${name}`,
    text: `From: ${name} <${email}>\n\n${message}`,
    html: `<p><strong>From:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p>
           <p style="white-space:pre-wrap;">${escapeHtml(message)}</p>`,
  });

  await db.query(
    'UPDATE contact_submissions SET email_status = $1, email_error = $2 WHERE id = $3',
    [result.status, result.error || '', submissionId]
  );

  res.render('store/contact', { title: 'Thanks', cart: getCart(req), submitted: true });
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── Home — list active stores ────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const stores = await db.query('SELECT * FROM stores WHERE active = true ORDER BY name');
  res.render('store/index', { title: 'Stores', stores: stores.rows, cart: getCart(req) });
});

// Tax is computed per-line so a multi-store cart doesn't silently lose one store's
// tax rate. blendedTaxRate is set only when every line has the same rate (so the
// view can show "Tax (6%)"); otherwise null and the view just shows the dollar amount.
function computeCartTotals(cart) {
  const subtotal = cart.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
  const tax = Math.round(
    cart.reduce((sum, i) => sum + i.unitPrice * i.quantity * (i.taxRate || 0), 0) * 100
  ) / 100;
  const rates = new Set(cart.map(i => Number(i.taxRate || 0)));
  const blendedTaxRate = rates.size === 1 ? [...rates][0] : null;
  return { subtotal, tax, total: subtotal + tax, blendedTaxRate };
}

// ─── Cart page ────────────────────────────────────────────────────────────────
router.get('/cart', (req, res) => {
  const cart = getCart(req);
  res.render('store/cart', { title: 'Your Cart', cart, ...computeCartTotals(cart) });
});

router.post('/cart/add', async (req, res) => {
  const { item_id, color_id, size_id, quantity, personalization_name, personalization_number } = req.body;

  // Fetch item + store in one query to get store-level personalization pricing + deadline state
  const item = await db.query(
    `SELECT i.*, s.slug as store_slug, s.id as sid, s.active as store_active,
            s.orders_close_at, s.order_deadline_message,
            s.personalization_name_price, s.personalization_number_price, s.tax_rate
     FROM items i JOIN stores s ON i.store_id = s.id WHERE i.id = $1`, [item_id]);
  if (!item.rows[0]) return res.redirect('/');
  const it = item.rows[0];

  // Block additions if store is closed or past deadline
  const storeOpen = it.store_active && (!it.orders_close_at || new Date() < new Date(it.orders_close_at));
  if (!storeOpen) {
    req.session.flash = { type: 'error', message: it.order_deadline_message || 'Orders for this store are closed.' };
    return res.redirect(`/store/${it.store_slug}`);
  }

  let colorName = '';
  if (color_id) {
    const color = await db.query('SELECT * FROM item_colors WHERE id = $1', [color_id]);
    if (color.rows[0]) colorName = color.rows[0].name;
  }

  let sizeName = '', sizeModifier = 0;
  if (size_id) {
    const size = await db.query('SELECT * FROM store_sizes WHERE id = $1', [size_id]);
    if (size.rows[0]) {
      sizeName = size.rows[0].name;
      sizeModifier = parseFloat(size.rows[0].price_modifier) || 0;
    }
  }

  // Build unit price: base + size modifier + personalization (name and number priced independently)
  let unitPrice = parseFloat(it.base_price) + sizeModifier;
  let personalizationTotal = 0;
  if (it.personalization_enabled) {
    if (personalization_name) {
      personalizationTotal += parseFloat(it.personalization_name_price) || 0;
    }
    if (personalization_number) {
      personalizationTotal += parseFloat(it.personalization_number_price) || 0;
    }
  }
  unitPrice += personalizationTotal;

  const cart = getCart(req);
  cart.push({
    itemId: it.id,
    itemName: it.name,
    colorId: color_id || null,
    colorName,
    sizeId: size_id || null,
    sizeName,
    quantity: parseInt(quantity) || 1,
    unitPrice,
    personalizationName: personalization_name || '',
    personalizationNumber: personalization_number || '',
    storeId: it.sid,
    storeSlug: it.store_slug,
    taxRate: parseFloat(it.tax_rate) || 0,
  });

  req.session.flash = { type: 'success', message: `${it.name} added to cart.` };
  res.redirect(`/store/${it.store_slug}`);
});

router.post('/cart/remove', (req, res) => {
  const idx = parseInt(req.body.index);
  const cart = getCart(req);
  if (idx >= 0 && idx < cart.length) cart.splice(idx, 1);
  res.redirect('/cart');
});

router.post('/cart/clear', (req, res) => {
  req.session.cart = [];
  res.redirect('/cart');
});

// ─── Store page — list items ──────────────────────────────────────────────────
router.get('/store/:slug', async (req, res) => {
  const store = await db.query('SELECT * FROM stores WHERE slug = $1 AND active = true', [req.params.slug]);
  if (!store.rows[0]) return res.status(404).render('store/404', { title: 'Store Not Found', cart: getCart(req) });

  const items = await db.query('SELECT * FROM items WHERE store_id = $1 AND active = true ORDER BY sort_order, id', [store.rows[0].id]);
  res.render('store/store', { title: store.rows[0].name, store: store.rows[0], items: items.rows, cart: getCart(req) });
});

// ─── Item detail page ─────────────────────────────────────────────────────────
router.get('/store/:slug/:itemId', async (req, res) => {
  const store = await db.query('SELECT * FROM stores WHERE slug = $1 AND active = true', [req.params.slug]);
  if (!store.rows[0]) return res.status(404).render('store/404', { title: 'Not Found', cart: getCart(req) });

  const item = await db.query('SELECT * FROM items WHERE id = $1 AND store_id = $2 AND active = true', [req.params.itemId, store.rows[0].id]);
  if (!item.rows[0]) return res.status(404).render('store/404', { title: 'Item Not Found', cart: getCart(req) });

  const colors = await db.query('SELECT * FROM item_colors WHERE item_id = $1 ORDER BY sort_order, id', [req.params.itemId]);
  const sizes = await db.query('SELECT * FROM store_sizes WHERE store_id = $1 ORDER BY sort_order, id', [store.rows[0].id]);

  res.render('store/item', {
    title: item.rows[0].name,
    store: store.rows[0],
    item: item.rows[0],
    colors: colors.rows,
    sizes: sizes.rows,
    cart: getCart(req),
    storeOpen: isStoreOpen(store.rows[0]),
  });
});

module.exports = router;
module.exports.computeCartTotals = computeCartTotals;

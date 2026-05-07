const express = require('express');
const rateLimit = require('express-rate-limit');
const router  = express.Router();
const bcrypt  = require('bcrypt');
const multer  = require('multer');
const path    = require('path');
const config  = require('../config');
const db      = require('../db');
const { csrfCheck } = require('../csrf');
const siteSettings = require('../site-settings');
const orderStatus  = require('../order-status');
const { sendCustomerStatusEmail, sendTestEmail } = require('../mailer');
const { getSquareConfig } = require('../square-config');
const { sanitizeRichText, safeUrl } = require('../sanitize');

// ─── Multer for image uploads ─────────────────────────────────────────────────
// Accept only common image formats. SVG explicitly disallowed because it can
// contain executable script. Filename derived from crypto-random bytes so a
// crafted originalname can't path-traverse or overwrite anything.
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MIME_TO_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };

const crypto = require('crypto');
const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'public', 'uploads'),
  filename: (_req, file, cb) => {
    const ext = MIME_TO_EXT[file.mimetype] || '.bin';
    const rnd = crypto.randomBytes(12).toString('hex');
    cb(null, `${Date.now()}-${rnd}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPG, PNG, GIF, or WebP images are allowed.'));
  },
});

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session.adminLoggedIn) return next();
  res.redirect('/admin/login');
}

// Rate limit failed login attempts. 10 per IP per 15 min — generous for legitimate
// retries (typo, forgot password) but tight against brute force.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: 'Too many login attempts. Please try again in 15 minutes.',
});

// ─── Login ────────────────────────────────────────────────────────────────────
router.get('/login', (req, res) => {
  if (req.session.adminLoggedIn) return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin Login' });
});

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  // DB hash takes precedence over env hash, so /admin/settings password changes work.
  const settings = await siteSettings.load();
  const effectiveHash = settings.site.adminPasswordHash || config.admin.passwordHash;

  if (username === config.admin.username && effectiveHash) {
    const match = await bcrypt.compare(password, effectiveHash);
    if (match) {
      // Regenerate the session on auth so any pre-auth CSRF token is rotated and
      // an attacker who set a session cookie pre-login can't ride it post-login.
      return req.session.regenerate((err) => {
        if (err) {
          console.error('session.regenerate failed:', err);
          req.session.flash = { type: 'error', message: 'Login error. Please try again.' };
          return res.redirect('/admin/login');
        }
        req.session.adminLoggedIn = true;
        res.redirect('/admin');
      });
    }
  }
  req.session.flash = { type: 'error', message: 'Invalid username or password.' };
  res.redirect('/admin/login');
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ─── Dashboard ────────────────────────────────────────────────────────────────
router.get('/', requireAdmin, async (req, res) => {
  // Counts split by lifecycle stage. "needs_action" = paid or processing (in your queue)
  const counts = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('paid','processing'))::int AS needs_action,
      COUNT(*) FILTER (WHERE status = 'ready')::int                AS ready,
      COUNT(*) FILTER (WHERE status = 'fulfilled')::int            AS fulfilled,
      COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('failed','cancelled','refunded','pending')), 0)::numeric(12,2) AS revenue
    FROM orders
  `);

  // Per-store breakdown of paid+ orders
  const storeRows = await db.query(`
    SELECT s.*,
      COUNT(o.id) FILTER (WHERE o.status IN ('paid','processing','ready','fulfilled'))::int AS order_count,
      COALESCE(SUM(o.total_amount) FILTER (WHERE o.status IN ('paid','processing','ready','fulfilled')), 0)::numeric(12,2) AS revenue
    FROM stores s
    LEFT JOIN orders o ON o.store_id = s.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `);

  // Recent orders
  const recent = await db.query(`
    SELECT o.id, o.customer_name, o.total_amount, o.status, o.created_at, s.name AS store_name
    FROM orders o LEFT JOIN stores s ON o.store_id = s.id
    ORDER BY o.created_at DESC LIMIT 10
  `);

  res.render('admin/dashboard', {
    title: 'Dashboard',
    counts: counts.rows[0],
    stores: storeRows.rows,
    recent: recent.rows,
  });
});

// ─── Stores CRUD ──────────────────────────────────────────────────────────────
router.get('/stores', requireAdmin, async (req, res) => {
  const stores = await db.query('SELECT * FROM stores ORDER BY created_at DESC');
  res.render('admin/stores', { title: 'Manage Stores', stores: stores.rows });
});

router.get('/stores/new', requireAdmin, async (req, res) => {
  // Pre-fill form with shop defaults
  const defaults = await db.query('SELECT * FROM shop_defaults WHERE id = 1');
  const d = defaults.rows[0];
  const prefill = d ? {
    personalization_name_price: d.default_personalization_name_price,
    personalization_number_price: d.default_personalization_number_price,
    tax_rate: d.default_tax_rate,
  } : null;
  res.render('admin/store-form', { title: 'New Store', store: prefill });
});

router.post('/stores/new', requireAdmin, upload.single('image'), csrfCheck, async (req, res) => {
  const { name, slug, description, active, personalization_name_price, personalization_number_price, tax_rate,
          orders_close_at, order_deadline_message } = req.body;
  // file → server-generated /uploads path; otherwise sanitize whatever was hidden in the form
  const image_url = req.file ? `/uploads/${req.file.filename}` : safeUrl(req.body.existing_image);
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const closeAt = orders_close_at ? orders_close_at : null;

  let newStoreId;
  try {
    const result = await db.query(
      `INSERT INTO stores (name, slug, description, image_url, active, personalization_name_price, personalization_number_price, tax_rate, orders_close_at, order_deadline_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [name, cleanSlug, description || '', image_url, active === 'on',
       parseFloat(personalization_name_price) || 0, parseFloat(personalization_number_price) || 0,
       parseFloat(tax_rate) >= 0 ? parseFloat(tax_rate) / 100 : 0.06,
       closeAt, order_deadline_message || '']
    );
    newStoreId = result.rows[0].id;
  } catch (err) {
    if (err.code === '23505') {
      // Re-render the form with submitted values so the operator doesn't lose their work
      return res.status(400).render('admin/store-form', {
        title: 'New Store',
        store: { name, slug: cleanSlug, description, image_url, active: active === 'on',
                 personalization_name_price, personalization_number_price, tax_rate: (parseFloat(tax_rate) || 6) / 100 },
        flash: { type: 'error', message: `A store with slug "${cleanSlug}" already exists. Pick a different one.` },
      });
    }
    throw err;
  }

  // Auto-seed sizes from default template
  const defaultSizes = await db.query('SELECT * FROM default_sizes ORDER BY sort_order, id');
  for (const s of defaultSizes.rows) {
    await db.query(
      'INSERT INTO store_sizes (store_id, name, price_modifier, sort_order) VALUES ($1, $2, $3, $4)',
      [newStoreId, s.name, s.price_modifier, s.sort_order]
    );
  }

  const sizeCount = defaultSizes.rows.length;
  req.session.flash = { type: 'success', message: `Store "${name}" created with ${sizeCount} default sizes.` };
  res.redirect('/admin/stores');
});

router.get('/stores/:id/edit', requireAdmin, async (req, res) => {
  const store = await db.query('SELECT * FROM stores WHERE id = $1', [req.params.id]);
  if (!store.rows[0]) return res.redirect('/admin/stores');
  res.render('admin/store-form', { title: 'Edit Store', store: store.rows[0] });
});

router.post('/stores/:id/edit', requireAdmin, upload.single('image'), csrfCheck, async (req, res) => {
  const { name, slug, description, active, personalization_name_price, personalization_number_price, tax_rate,
          orders_close_at, order_deadline_message } = req.body;
  const image_url = req.file ? `/uploads/${req.file.filename}` : safeUrl(req.body.existing_image);
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const closeAt = orders_close_at ? orders_close_at : null;

  try {
    await db.query(
      `UPDATE stores SET name=$1, slug=$2, description=$3, image_url=$4, active=$5,
       personalization_name_price=$6, personalization_number_price=$7, tax_rate=$8,
       orders_close_at=$9, order_deadline_message=$10, updated_at=NOW() WHERE id=$11`,
      [name, cleanSlug, description || '', image_url, active === 'on',
       parseFloat(personalization_name_price) || 0, parseFloat(personalization_number_price) || 0,
       parseFloat(tax_rate) >= 0 ? parseFloat(tax_rate) / 100 : 0.06,
       closeAt, order_deadline_message || '',
       req.params.id]
    );
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).render('admin/store-form', {
        title: 'Edit Store',
        store: { id: req.params.id, name, slug: cleanSlug, description, image_url, active: active === 'on',
                 personalization_name_price, personalization_number_price, tax_rate: (parseFloat(tax_rate) || 6) / 100 },
        flash: { type: 'error', message: `A store with slug "${cleanSlug}" already exists. Pick a different one.` },
      });
    }
    throw err;
  }
  req.session.flash = { type: 'success', message: `Store "${name}" updated.` };
  res.redirect('/admin/stores');
});

router.post('/stores/:id/toggle', requireAdmin, async (req, res) => {
  await db.query('UPDATE stores SET active = NOT active, updated_at = NOW() WHERE id = $1', [req.params.id]);
  res.redirect('/admin/stores');
});

router.post('/stores/:id/delete', requireAdmin, async (req, res) => {
  await db.query('DELETE FROM stores WHERE id = $1', [req.params.id]);
  req.session.flash = { type: 'success', message: 'Store deleted.' };
  res.redirect('/admin/stores');
});

// ─── Items CRUD ───────────────────────────────────────────────────────────────
router.get('/stores/:storeId/items', requireAdmin, async (req, res) => {
  const store = await db.query('SELECT * FROM stores WHERE id = $1', [req.params.storeId]);
  if (!store.rows[0]) return res.redirect('/admin/stores');
  const items = await db.query('SELECT * FROM items WHERE store_id = $1 ORDER BY sort_order, id', [req.params.storeId]);
  res.render('admin/items', { title: 'Items', store: store.rows[0], items: items.rows });
});

router.get('/stores/:storeId/items/new', requireAdmin, async (req, res) => {
  const store = await db.query('SELECT * FROM stores WHERE id = $1', [req.params.storeId]);
  if (!store.rows[0]) return res.redirect('/admin/stores');
  res.render('admin/item-form', { title: 'New Item', store: store.rows[0], item: null });
});

router.post('/stores/:storeId/items/new', requireAdmin, upload.single('image'), csrfCheck, async (req, res) => {
  const { name, description, base_price, personalization_enabled, sort_order } = req.body;
  const image_url = req.file ? `/uploads/${req.file.filename}` : '';
  await db.query(
    `INSERT INTO items (store_id, name, description, image_url, base_price, personalization_enabled, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [req.params.storeId, name, description || '', image_url,
     parseFloat(base_price) || 0, personalization_enabled === 'on',
     parseInt(sort_order) || 0]
  );
  req.session.flash = { type: 'success', message: `Item "${name}" created.` };
  res.redirect(`/admin/stores/${req.params.storeId}/items`);
});

router.get('/stores/:storeId/items/:id/edit', requireAdmin, async (req, res) => {
  const store = await db.query('SELECT * FROM stores WHERE id = $1', [req.params.storeId]);
  const item = await db.query('SELECT * FROM items WHERE id = $1 AND store_id = $2', [req.params.id, req.params.storeId]);
  if (!store.rows[0] || !item.rows[0]) return res.redirect(`/admin/stores/${req.params.storeId}/items`);
  res.render('admin/item-form', { title: 'Edit Item', store: store.rows[0], item: item.rows[0] });
});

router.post('/stores/:storeId/items/:id/edit', requireAdmin, upload.single('image'), csrfCheck, async (req, res) => {
  const { name, description, base_price, personalization_enabled, sort_order } = req.body;
  const image_url = req.file ? `/uploads/${req.file.filename}` : safeUrl(req.body.existing_image);
  await db.query(
    `UPDATE items SET name=$1, description=$2, image_url=$3, base_price=$4, personalization_enabled=$5,
     sort_order=$6 WHERE id=$7 AND store_id=$8`,
    [name, description || '', image_url, parseFloat(base_price) || 0,
     personalization_enabled === 'on',
     parseInt(sort_order) || 0, req.params.id, req.params.storeId]
  );
  req.session.flash = { type: 'success', message: `Item "${name}" updated.` };
  res.redirect(`/admin/stores/${req.params.storeId}/items`);
});

router.post('/stores/:storeId/items/:id/delete', requireAdmin, async (req, res) => {
  await db.query('DELETE FROM items WHERE id = $1 AND store_id = $2', [req.params.id, req.params.storeId]);
  req.session.flash = { type: 'success', message: 'Item deleted.' };
  res.redirect(`/admin/stores/${req.params.storeId}/items`);
});

// ─── Item Colors ──────────────────────────────────────────────────────────────
router.get('/stores/:storeId/items/:itemId/colors', requireAdmin, async (req, res) => {
  const store = await db.query('SELECT * FROM stores WHERE id = $1', [req.params.storeId]);
  const item = await db.query('SELECT * FROM items WHERE id = $1', [req.params.itemId]);
  const colors = await db.query('SELECT * FROM item_colors WHERE item_id = $1 ORDER BY sort_order, id', [req.params.itemId]);
  if (!store.rows[0] || !item.rows[0]) return res.redirect('/admin/stores');
  res.render('admin/colors', { title: 'Colors', store: store.rows[0], item: item.rows[0], colors: colors.rows });
});

router.post('/stores/:storeId/items/:itemId/colors', requireAdmin, async (req, res) => {
  const { name, hex_code, sort_order } = req.body;
  await db.query(
    'INSERT INTO item_colors (item_id, name, hex_code, sort_order) VALUES ($1, $2, $3, $4)',
    [req.params.itemId, name, hex_code || '#000000', parseInt(sort_order) || 0]
  );
  res.redirect(`/admin/stores/${req.params.storeId}/items/${req.params.itemId}/colors`);
});

router.post('/stores/:storeId/items/:itemId/colors/:id/delete', requireAdmin, async (req, res) => {
  await db.query('DELETE FROM item_colors WHERE id = $1', [req.params.id]);
  res.redirect(`/admin/stores/${req.params.storeId}/items/${req.params.itemId}/colors`);
});

// ─── Store Sizes ──────────────────────────────────────────────────────────────
router.get('/stores/:storeId/sizes', requireAdmin, async (req, res) => {
  const store = await db.query('SELECT * FROM stores WHERE id = $1', [req.params.storeId]);
  const sizes = await db.query('SELECT * FROM store_sizes WHERE store_id = $1 ORDER BY sort_order, id', [req.params.storeId]);
  if (!store.rows[0]) return res.redirect('/admin/stores');
  res.render('admin/sizes', { title: 'Sizes', store: store.rows[0], sizes: sizes.rows });
});

router.post('/stores/:storeId/sizes', requireAdmin, async (req, res) => {
  const { name, price_modifier, sort_order } = req.body;
  await db.query(
    'INSERT INTO store_sizes (store_id, name, price_modifier, sort_order) VALUES ($1, $2, $3, $4)',
    [req.params.storeId, name, parseFloat(price_modifier) || 0, parseInt(sort_order) || 0]
  );
  res.redirect(`/admin/stores/${req.params.storeId}/sizes`);
});

router.post('/stores/:storeId/sizes/:id/delete', requireAdmin, async (req, res) => {
  await db.query('DELETE FROM store_sizes WHERE id = $1', [req.params.id]);
  res.redirect(`/admin/stores/${req.params.storeId}/sizes`);
});

// ─── Pickup Events ────────────────────────────────────────────────────────────
router.get('/stores/:storeId/events', requireAdmin, async (req, res) => {
  const store = await db.query('SELECT * FROM stores WHERE id = $1', [req.params.storeId]);
  const events = await db.query('SELECT * FROM pickup_events WHERE store_id = $1 ORDER BY event_date', [req.params.storeId]);
  if (!store.rows[0]) return res.redirect('/admin/stores');
  res.render('admin/events', { title: 'Pickup Events', store: store.rows[0], events: events.rows });
});

router.post('/stores/:storeId/events', requireAdmin, async (req, res) => {
  const { name, event_date, event_time, location } = req.body;
  await db.query(
    'INSERT INTO pickup_events (store_id, name, event_date, event_time, location) VALUES ($1, $2, $3, $4, $5)',
    [req.params.storeId, name, event_date, event_time || '', location || '']
  );
  res.redirect(`/admin/stores/${req.params.storeId}/events`);
});

router.post('/stores/:storeId/events/:id/delete', requireAdmin, async (req, res) => {
  await db.query('DELETE FROM pickup_events WHERE id = $1', [req.params.id]);
  res.redirect(`/admin/stores/${req.params.storeId}/events`);
});

// Pickup-event roster — used at the distribution event to check customers in
router.get('/stores/:storeId/events/:id/roster', requireAdmin, async (req, res) => {
  const event = await db.query(
    `SELECT pe.*, s.name AS store_name, s.id AS sid
     FROM pickup_events pe JOIN stores s ON pe.store_id = s.id
     WHERE pe.id = $1 AND s.id = $2`,
    [req.params.id, req.params.storeId]
  );
  if (!event.rows[0]) return res.redirect('/admin/stores');

  const orders = await db.query(
    `SELECT o.*, COUNT(oi.id)::int AS line_count, SUM(oi.quantity)::int AS piece_count
     FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.pickup_event_id = $1 AND o.status NOT IN ('failed','cancelled','refunded')
     GROUP BY o.id
     ORDER BY o.customer_name`,
    [req.params.id]
  );

  // Pull all line items in one query, group by order_id in memory
  const orderIds = orders.rows.map(o => o.id);
  let linesByOrder = {};
  if (orderIds.length > 0) {
    const lines = await db.query(
      'SELECT * FROM order_items WHERE order_id = ANY($1::int[]) ORDER BY id',
      [orderIds]
    );
    for (const l of lines.rows) {
      (linesByOrder[l.order_id] ||= []).push(l);
    }
  }

  res.render('admin/event-roster', {
    title: 'Pickup Roster',
    event: event.rows[0],
    orders: orders.rows,
    linesByOrder,
  });
});

// ─── Shop Defaults ────────────────────────────────────────────────────────────
router.get('/defaults', requireAdmin, async (req, res) => {
  const defaults = await db.query('SELECT * FROM shop_defaults WHERE id = 1');
  const sizes = await db.query('SELECT * FROM default_sizes ORDER BY sort_order, id');
  res.render('admin/defaults', {
    title: 'Shop Defaults',
    defaults: defaults.rows[0] || { default_tax_rate: 0.06, default_personalization_name_price: 0, default_personalization_number_price: 0 },
    sizes: sizes.rows,
  });
});

router.post('/defaults', requireAdmin, async (req, res) => {
  const { default_tax_rate, default_personalization_name_price, default_personalization_number_price } = req.body;
  await db.query(
    `UPDATE shop_defaults SET default_tax_rate = $1, default_personalization_name_price = $2,
     default_personalization_number_price = $3 WHERE id = 1`,
    [parseFloat(default_tax_rate) >= 0 ? parseFloat(default_tax_rate) / 100 : 0.06,
     parseFloat(default_personalization_name_price) || 0,
     parseFloat(default_personalization_number_price) || 0]
  );
  req.session.flash = { type: 'success', message: 'Shop defaults saved.' };
  res.redirect('/admin/defaults');
});

router.post('/defaults/sizes', requireAdmin, async (req, res) => {
  const { name, price_modifier, sort_order } = req.body;
  await db.query(
    'INSERT INTO default_sizes (name, price_modifier, sort_order) VALUES ($1, $2, $3)',
    [name, parseFloat(price_modifier) || 0, parseInt(sort_order) || 0]
  );
  res.redirect('/admin/defaults');
});

router.post('/defaults/sizes/:id/delete', requireAdmin, async (req, res) => {
  await db.query('DELETE FROM default_sizes WHERE id = $1', [req.params.id]);
  res.redirect('/admin/defaults');
});

//─── Orders ───────────────────────────────────────────────────────────────────
router.get('/orders', requireAdmin, async (req, res) => {
  const filters = {
    store_id: req.query.store_id || '',
    status:   req.query.status   || '',
    q:        (req.query.q || '').trim(),
    from:     req.query.from || '',
    to:       req.query.to   || '',
  };

  const where = [];
  const params = [];
  if (filters.store_id) { params.push(parseInt(filters.store_id)); where.push(`o.store_id = $${params.length}`); }
  if (filters.status && orderStatus.isValid(filters.status)) {
    params.push(filters.status); where.push(`o.status = $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q.toLowerCase()}%`);
    where.push(`(LOWER(o.customer_name) LIKE $${params.length} OR LOWER(o.customer_email) LIKE $${params.length})`);
  }
  if (filters.from) { params.push(filters.from); where.push(`o.created_at >= $${params.length}::date`); }
  if (filters.to)   { params.push(filters.to);   where.push(`o.created_at <  $${params.length}::date + INTERVAL '1 day'`); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const orders = await db.query(
    `SELECT o.*, s.name as store_name
     FROM orders o LEFT JOIN stores s ON o.store_id = s.id
     ${whereSql}
     ORDER BY o.created_at DESC LIMIT 500`,
    params
  );
  const stores = await db.query('SELECT id, name FROM stores ORDER BY name');

  res.render('admin/orders', {
    title: 'Orders',
    orders: orders.rows,
    stores: stores.rows,
    filters,
  });
});

router.get('/orders/:id', requireAdmin, async (req, res) => {
  const order = await db.query(
    `SELECT o.*, s.name as store_name, pe.name as event_name, pe.event_date, pe.location as event_location
     FROM orders o LEFT JOIN stores s ON o.store_id = s.id
     LEFT JOIN pickup_events pe ON o.pickup_event_id = pe.id
     WHERE o.id = $1`, [req.params.id]
  );
  if (!order.rows[0]) return res.redirect('/admin/orders');
  const items = await db.query('SELECT * FROM order_items WHERE order_id = $1', [req.params.id]);
  const log = await db.query(
    'SELECT * FROM order_status_log WHERE order_id = $1 ORDER BY created_at DESC',
    [req.params.id]
  );
  res.render('admin/order-detail', {
    title: 'Order Detail',
    order: order.rows[0],
    items: items.rows,
    log: log.rows,
  });
});

router.post('/orders/:id/status', requireAdmin, async (req, res) => {
  const orderId = parseInt(req.params.id);
  const newStatus = req.body.status;
  const note = (req.body.note || '').trim().slice(0, 2000);
  const notifyCustomer = req.body.notify_customer === 'on';

  if (!orderStatus.isValid(newStatus)) {
    req.session.flash = { type: 'error', message: `Unknown status: ${newStatus}` };
    return res.redirect(`/admin/orders/${orderId}`);
  }

  const cur = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!cur.rows[0]) return res.redirect('/admin/orders');
  const order = cur.rows[0];

  // No-op if status didn't change AND no note provided
  if (order.status === newStatus && !note) {
    req.session.flash = { type: 'error', message: 'No change to save.' };
    return res.redirect(`/admin/orders/${orderId}`);
  }

  await db.query('UPDATE orders SET status = $1 WHERE id = $2', [newStatus, orderId]);
  await db.query(
    'INSERT INTO order_status_log (order_id, from_status, to_status, note) VALUES ($1, $2, $3, $4)',
    [orderId, order.status, newStatus, note]
  );

  let emailMessage = '';
  if (notifyCustomer && order.customer_email) {
    const settings = await siteSettings.load();
    const result = await sendCustomerStatusEmail({
      to: order.customer_email,
      customerName: order.customer_name,
      orderId,
      statusInfo: orderStatus.info(newStatus),
      brandName: settings.brand.name,
      note,
    });
    emailMessage = result.status === 'sent' ? ' Customer notified.' :
                   result.status === 'failed' ? ` Customer email failed: ${result.error}` :
                   ` Customer email skipped: ${result.error}`;
  }

  req.session.flash = { type: 'success', message: `Status set to ${orderStatus.info(newStatus).label}.${emailMessage}` };
  res.redirect(`/admin/orders/${orderId}`);
});

router.post('/orders/bulk-status', requireAdmin, async (req, res) => {
  const newStatus = req.body.status;
  const notify = req.body.notify_customer === 'on';
  const ids = (Array.isArray(req.body.order_ids) ? req.body.order_ids : [req.body.order_ids])
    .map(Number).filter(n => Number.isFinite(n));

  if (!orderStatus.isValid(newStatus) || ids.length === 0) {
    req.session.flash = { type: 'error', message: 'Pick a status and at least one order.' };
    return res.redirect('/admin/orders');
  }

  const cur = await db.query('SELECT id, status, customer_email, customer_name FROM orders WHERE id = ANY($1::int[])', [ids]);
  let changed = 0, emailsAttempted = 0, emailsFailed = 0;
  const settings = notify ? await siteSettings.load() : null;

  for (const order of cur.rows) {
    if (order.status === newStatus) continue;
    await db.query('UPDATE orders SET status = $1 WHERE id = $2', [newStatus, order.id]);
    await db.query(
      'INSERT INTO order_status_log (order_id, from_status, to_status, note) VALUES ($1, $2, $3, $4)',
      [order.id, order.status, newStatus, 'Bulk update']
    );
    changed++;

    if (notify && order.customer_email && settings) {
      emailsAttempted++;
      const result = await sendCustomerStatusEmail({
        to: order.customer_email,
        customerName: order.customer_name,
        orderId: order.id,
        statusInfo: orderStatus.info(newStatus),
        brandName: settings.brand.name,
        note: '',
      });
      if (result.status !== 'sent') emailsFailed++;
    }
  }

  let msg = `${changed} order${changed === 1 ? '' : 's'} moved to ${orderStatus.info(newStatus).label}.`;
  if (notify) {
    msg += ` Email: ${emailsAttempted - emailsFailed} sent, ${emailsFailed} failed/skipped.`;
  }
  req.session.flash = { type: 'success', message: msg };
  res.redirect('/admin/orders');
});

// Recomputes order subtotal/tax/total from current line items and the order's
// store tax rate. Returns the new totals so the caller can write them.
async function recomputeOrderTotals(orderId) {
  const lines = await db.query('SELECT quantity, unit_price FROM order_items WHERE order_id = $1', [orderId]);
  const subtotal = lines.rows.reduce((s, l) => s + parseFloat(l.unit_price) * l.quantity, 0);

  const store = await db.query(
    'SELECT s.tax_rate FROM orders o JOIN stores s ON o.store_id = s.id WHERE o.id = $1',
    [orderId]
  );
  const taxRate = store.rows[0] ? parseFloat(store.rows[0].tax_rate) : 0;
  const tax = Math.round(subtotal * taxRate * 100) / 100;
  const total = subtotal + tax;

  await db.query(
    'UPDATE orders SET total_amount = $1, tax_amount = $2 WHERE id = $3',
    [total, tax, orderId]
  );
  return { subtotal, tax, total };
}

router.post('/orders/:id/items/:lineId/edit', requireAdmin, async (req, res) => {
  const orderId = parseInt(req.params.id);
  const lineId  = parseInt(req.params.lineId);
  const quantity = Math.max(1, Math.min(parseInt(req.body.quantity) || 1, 999));
  const pName   = (req.body.personalization_name   || '').slice(0, 255);
  const pNumber = (req.body.personalization_number || '').slice(0, 50);

  const cur = await db.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2', [lineId, orderId]);
  if (!cur.rows[0]) return res.redirect(`/admin/orders/${orderId}`);
  const before = cur.rows[0];

  await db.query(
    `UPDATE order_items SET quantity = $1, personalization_name = $2, personalization_number = $3
     WHERE id = $4 AND order_id = $5`,
    [quantity, pName, pNumber, lineId, orderId]
  );
  await recomputeOrderTotals(orderId);

  // Audit
  const orderRow = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  const changes = [];
  if (before.quantity !== quantity) changes.push(`qty ${before.quantity} → ${quantity}`);
  if ((before.personalization_name || '') !== pName) changes.push(`name "${before.personalization_name || ''}" → "${pName}"`);
  if ((before.personalization_number || '') !== pNumber) changes.push(`# "${before.personalization_number || ''}" → "${pNumber}"`);
  if (changes.length > 0) {
    await db.query(
      'INSERT INTO order_status_log (order_id, from_status, to_status, note) VALUES ($1, $2, $2, $3)',
      [orderId, orderRow.rows[0].status, `Line "${before.item_name}": ${changes.join(', ')}`]
    );
  }

  req.session.flash = { type: 'success', message: changes.length ? `Line updated (${changes.join(', ')}).` : 'No changes.' };
  res.redirect(`/admin/orders/${orderId}`);
});

router.post('/orders/:id/items/:lineId/delete', requireAdmin, async (req, res) => {
  const orderId = parseInt(req.params.id);
  const lineId  = parseInt(req.params.lineId);

  const cur = await db.query('SELECT * FROM order_items WHERE id = $1 AND order_id = $2', [lineId, orderId]);
  if (!cur.rows[0]) return res.redirect(`/admin/orders/${orderId}`);
  const removed = cur.rows[0];

  await db.query('DELETE FROM order_items WHERE id = $1 AND order_id = $2', [lineId, orderId]);
  await recomputeOrderTotals(orderId);

  const orderRow = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  await db.query(
    'INSERT INTO order_status_log (order_id, from_status, to_status, note) VALUES ($1, $2, $2, $3)',
    [orderId, orderRow.rows[0].status, `Removed line: ${removed.quantity}× ${removed.item_name}`]
  );

  req.session.flash = { type: 'success', message: `Removed: ${removed.quantity}× ${removed.item_name}.` };
  res.redirect(`/admin/orders/${orderId}`);
});

// Process a Square refund for the original payment. Full-refund only (partial
// refunds add complexity we don't need yet). Sandbox-shortcircuit orders are
// flagged and refunded without a Square API call.
router.post('/orders/:id/refund', requireAdmin, async (req, res) => {
  const orderId = parseInt(req.params.id);
  const cur = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (!cur.rows[0]) return res.redirect('/admin/orders');
  const order = cur.rows[0];

  if (order.status === 'refunded') {
    req.session.flash = { type: 'error', message: 'Order is already refunded.' };
    return res.redirect(`/admin/orders/${orderId}`);
  }

  const paymentId = order.square_payment_id || '';
  const isSandbox = paymentId.startsWith('sandbox-');

  let refundId = '';
  let logNote = '';

  if (isSandbox) {
    // No real charge ever happened; just flag it
    refundId = `sandbox-refund-${Date.now()}`;
    logNote = 'Sandbox order — flagged refunded (no Square API call)';
  } else if (!paymentId) {
    req.session.flash = { type: 'error', message: 'Cannot process refund — no Square payment ID on this order. If the customer paid through another channel, set status to "Refunded" manually.' };
    return res.redirect(`/admin/orders/${orderId}`);
  } else {
    try {
      const square = await getSquareConfig();
      const { Client, Environment } = require('square');
      const client = new Client({
        accessToken: square.accessToken,
        environment: square.environment === 'production' ? Environment.Production : Environment.Sandbox,
      });
      const { result } = await client.refundsApi.refundPayment({
        // Stable per-order key so accidental double-clicks dedupe at Square.
        idempotencyKey: `refund-${orderId}`,
        paymentId,
        amountMoney: {
          amount: BigInt(Math.round(parseFloat(order.total_amount) * 100)),
          currency: 'USD',
        },
        reason: `Order #${orderId} refund via admin`,
      });
      refundId = (result.refund && result.refund.id) || '';
      logNote = `Square refund issued: ${refundId} for $${parseFloat(order.total_amount).toFixed(2)}`;
    } catch (err) {
      const detail = (err.errors && err.errors[0] && err.errors[0].detail) || err.message || String(err);
      req.session.flash = { type: 'error', message: `Square refund failed: ${detail}. Order status NOT changed. Either retry or set status manually.` };
      return res.redirect(`/admin/orders/${orderId}`);
    }
  }

  await db.query(
    'UPDATE orders SET status = $1, refund_id = $2, refund_amount = $3, refunded_at = NOW() WHERE id = $4',
    ['refunded', refundId, order.total_amount, orderId]
  );
  await db.query(
    'INSERT INTO order_status_log (order_id, from_status, to_status, note) VALUES ($1, $2, $3, $4)',
    [orderId, order.status, 'refunded', logNote]
  );

  // Notify customer (best-effort)
  if (order.customer_email) {
    const settings = await siteSettings.load();
    sendCustomerStatusEmail({
      to: order.customer_email,
      customerName: order.customer_name,
      orderId,
      statusInfo: orderStatus.info('refunded'),
      brandName: settings.brand.name,
      note: `Refund of $${parseFloat(order.total_amount).toFixed(2)} has been processed.`,
    }).catch(() => {});
  }

  req.session.flash = { type: 'success', message: logNote };
  res.redirect(`/admin/orders/${orderId}`);
});

// Quick "mark fulfilled" button — used from the pickup roster. Logs the change
// and bounces back to wherever the operator was (?return=...).
router.post('/orders/:id/fulfill', requireAdmin, async (req, res) => {
  const orderId = parseInt(req.params.id);
  const cur = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  if (!cur.rows[0]) return res.redirect('/admin/orders');

  if (cur.rows[0].status !== 'fulfilled') {
    await db.query('UPDATE orders SET status = $1 WHERE id = $2', ['fulfilled', orderId]);
    await db.query(
      'INSERT INTO order_status_log (order_id, from_status, to_status, note) VALUES ($1, $2, $3, $4)',
      [orderId, cur.rows[0].status, 'fulfilled', 'Marked fulfilled at pickup']
    );
  }

  // Only allow same-origin redirects. `/path` is OK; `//evil.com` (protocol-relative)
  // and any backslash variant are NOT.
  const ret = String(req.query.return || '');
  const isLocal = ret.startsWith('/') && !ret.startsWith('//') && !ret.startsWith('/\\');
  const back = isLocal ? ret : `/admin/orders/${orderId}`;
  res.redirect(back);
});

router.post('/orders/:id/note', requireAdmin, async (req, res) => {
  const orderId = parseInt(req.params.id);
  const note = (req.body.note || '').trim().slice(0, 2000);
  if (!note) return res.redirect(`/admin/orders/${orderId}`);

  const cur = await db.query('SELECT status FROM orders WHERE id = $1', [orderId]);
  if (!cur.rows[0]) return res.redirect('/admin/orders');

  await db.query(
    'INSERT INTO order_status_log (order_id, from_status, to_status, note) VALUES ($1, $2, $2, $3)',
    [orderId, cur.rows[0].status, note]
  );
  req.session.flash = { type: 'success', message: 'Note added.' };
  res.redirect(`/admin/orders/${orderId}`);
});

// ─── Print Report ─────────────────────────────────────────────────────────────
router.get('/stores/:storeId/report', requireAdmin, async (req, res) => {
  const store = await db.query('SELECT * FROM stores WHERE id = $1', [req.params.storeId]);
  if (!store.rows[0]) return res.redirect('/admin/stores');

  // Blank apparel summary: item + color + size → total quantity
  const blanks = await db.query(`
    SELECT oi.item_name, oi.color_name, oi.size_name, SUM(oi.quantity) as total_qty
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    WHERE o.store_id = $1 AND o.status = 'paid'
    GROUP BY oi.item_name, oi.color_name, oi.size_name
    ORDER BY oi.item_name, oi.color_name, oi.size_name
  `, [req.params.storeId]);

  // Personalization list
  const personalizations = await db.query(`
    SELECT oi.item_name, oi.color_name, oi.size_name, oi.personalization_name, oi.personalization_number,
           oi.quantity, o.customer_name
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    WHERE o.store_id = $1 AND o.status = 'paid'
      AND (oi.personalization_name != '' OR oi.personalization_number != '')
    ORDER BY oi.item_name, o.customer_name
  `, [req.params.storeId]);

  res.render('admin/report', {
    title: 'Print Report',
    store: store.rows[0],
    blanks: blanks.rows,
    personalizations: personalizations.rows,
  });
});

// ─── CSV Export ───────────────────────────────────────────────────────────────
router.get('/stores/:storeId/export', requireAdmin, async (req, res) => {
  const store = await db.query('SELECT * FROM stores WHERE id = $1', [req.params.storeId]);
  if (!store.rows[0]) return res.redirect('/admin/stores');

  const rows = await db.query(`
    SELECT o.id as order_id, o.customer_name, o.customer_email, o.customer_phone,
           o.customer_cell, o.customer_address, o.customer_city, o.customer_state, o.customer_zip,
           o.status, o.total_amount, o.created_at,
           oi.item_name, oi.color_name, oi.size_name, oi.quantity, oi.unit_price,
           oi.personalization_name, oi.personalization_number,
           pe.name as pickup_event
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    LEFT JOIN pickup_events pe ON o.pickup_event_id = pe.id
    WHERE o.store_id = $1
    ORDER BY o.created_at DESC
  `, [req.params.storeId]);

  const headers = [
    'Order ID','Customer','Email','Phone','Cell','Address','City','State','Zip',
    'Status','Total','Date','Item','Color','Size','Qty','Unit Price',
    'Personalization Name','Personalization Number','Pickup Event'
  ];

  // CSV value escape: defends against formula injection (CWE-1236) by prefixing
  // any value starting with =/+/-/@/tab/CR with a leading apostrophe, doubles
  // inner quotes, and wraps everything in double quotes for safety.
  const csvCell = (v) => {
    let s = (v === null || v === undefined) ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };

  const csvRows = [headers.map(csvCell).join(',')];
  for (const r of rows.rows) {
    csvRows.push([
      r.order_id, r.customer_name, r.customer_email, r.customer_phone,
      r.customer_cell, r.customer_address, r.customer_city, r.customer_state, r.customer_zip,
      r.status, r.total_amount, new Date(r.created_at).toLocaleDateString(),
      r.item_name, r.color_name, r.size_name, r.quantity, r.unit_price,
      r.personalization_name || '', r.personalization_number || '', r.pickup_event || '',
    ].map(csvCell).join(','));
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${store.rows[0].slug}-orders.csv"`);
  res.send(csvRows.join('\r\n'));
});

// ─── Reports ─────────────────────────────────────────────────────────────────
router.get('/reports', requireAdmin, (req, res) => {
  res.render('admin/reports/index', { title: 'Reports' });
});

// Sales tax: per-store breakdown over a date range, paid orders only
router.get('/reports/sales-tax', requireAdmin, async (req, res) => {
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const fromStr = req.query.from || firstOfMonth.toISOString().slice(0, 10);
  const toStr   = req.query.to   || today.toISOString().slice(0, 10);

  const result = await db.query(`
    SELECT s.id AS store_id, s.name AS store_name, s.tax_rate,
           COUNT(o.id)::int      AS order_count,
           COALESCE(SUM(o.total_amount - o.tax_amount), 0)::numeric(12,2) AS taxable_subtotal,
           COALESCE(SUM(o.tax_amount), 0)::numeric(12,2)                  AS tax_collected,
           COALESCE(SUM(o.total_amount), 0)::numeric(12,2)                AS gross_total
    FROM stores s
    LEFT JOIN orders o ON o.store_id = s.id
      AND o.status = 'paid'
      AND o.created_at >= $1::date
      AND o.created_at <  ($2::date + INTERVAL '1 day')
    GROUP BY s.id, s.name, s.tax_rate
    HAVING COUNT(o.id) > 0
    ORDER BY s.name
  `, [fromStr, toStr]);

  const totals = result.rows.reduce((acc, r) => {
    acc.orders          += r.order_count;
    acc.taxable_subtotal += parseFloat(r.taxable_subtotal);
    acc.tax_collected    += parseFloat(r.tax_collected);
    acc.gross_total      += parseFloat(r.gross_total);
    return acc;
  }, { orders: 0, taxable_subtotal: 0, tax_collected: 0, gross_total: 0 });

  res.render('admin/reports/sales-tax', {
    title: 'Sales Tax Report',
    rows: result.rows,
    totals,
    from: fromStr,
    to: toStr,
  });
});

// Vendor blank order: aggregate item × color × size across selected stores
router.get('/reports/blanks', requireAdmin, async (req, res) => {
  const allStores = await db.query('SELECT id, name, slug, active FROM stores ORDER BY active DESC, name');

  // Selected store ids: take from query, default to all active stores on first load
  let selectedIds;
  if (req.query.store_id) {
    selectedIds = (Array.isArray(req.query.store_id) ? req.query.store_id : [req.query.store_id]).map(Number).filter(n => Number.isFinite(n));
  } else if (req.query.applied === '1') {
    selectedIds = [];  // user explicitly unchecked everything
  } else {
    selectedIds = allStores.rows.filter(s => s.active).map(s => s.id);
  }

  let rows = [];
  let totalQty = 0;
  if (selectedIds.length > 0) {
    const result = await db.query(`
      SELECT oi.item_name, oi.color_name, oi.size_name,
             SUM(oi.quantity)::int AS total_qty
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.status = 'paid'
        AND o.store_id = ANY($1::int[])
      GROUP BY oi.item_name, oi.color_name, oi.size_name
      ORDER BY oi.item_name, oi.color_name, oi.size_name
    `, [selectedIds]);
    rows = result.rows;
    totalQty = rows.reduce((s, r) => s + r.total_qty, 0);
  }

  res.render('admin/reports/blanks', {
    title: 'Vendor Blank Order',
    allStores: allStores.rows,
    selectedIds,
    rows,
    totalQty,
  });
});

// CSV export for the same selection
router.get('/reports/blanks/export', requireAdmin, async (req, res) => {
  const ids = (Array.isArray(req.query.store_id) ? req.query.store_id : [req.query.store_id])
    .filter(Boolean).map(Number).filter(n => Number.isFinite(n));
  if (ids.length === 0) return res.status(400).send('No stores selected');

  const result = await db.query(`
    SELECT oi.item_name, oi.color_name, oi.size_name,
           SUM(oi.quantity)::int AS total_qty
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    WHERE o.status = 'paid' AND o.store_id = ANY($1::int[])
    GROUP BY oi.item_name, oi.color_name, oi.size_name
    ORDER BY oi.item_name, oi.color_name, oi.size_name
  `, [ids]);

  // CSV cell escape — see /admin/stores/:storeId/export for rationale.
  const csvCell = (v) => {
    let s = (v === null || v === undefined) ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };

  const csvRows = [['Item','Color','Size','Total Qty'].map(csvCell).join(',')];
  for (const r of result.rows) {
    csvRows.push([r.item_name, r.color_name || '', r.size_name || '', r.total_qty].map(csvCell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="blank-order.csv"');
  res.send(csvRows.join('\r\n'));
});

// Customization detail: per store + optional pickup event, every personalized line
router.get('/reports/customizations', requireAdmin, async (req, res) => {
  const allStores = await db.query('SELECT id, name, active FROM stores ORDER BY active DESC, name');
  const storeId = req.query.store_id ? parseInt(req.query.store_id) : null;
  const eventId = req.query.event_id ? parseInt(req.query.event_id) : null;

  let store = null, events = [], rows = [];
  if (storeId) {
    const sr = await db.query('SELECT * FROM stores WHERE id = $1', [storeId]);
    store = sr.rows[0] || null;
    if (store) {
      const er = await db.query('SELECT * FROM pickup_events WHERE store_id = $1 ORDER BY event_date', [storeId]);
      events = er.rows;

      const params = [storeId];
      let eventClause = '';
      if (eventId) { params.push(eventId); eventClause = ' AND o.pickup_event_id = $2'; }

      const result = await db.query(`
        SELECT oi.item_name, oi.color_name, oi.size_name,
               oi.personalization_name, oi.personalization_number,
               oi.quantity, o.id AS order_id, o.customer_name, o.customer_email,
               pe.name AS event_name, pe.event_date
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        LEFT JOIN pickup_events pe ON o.pickup_event_id = pe.id
        WHERE o.store_id = $1
          AND o.status = 'paid'
          AND (oi.personalization_name <> '' OR oi.personalization_number <> '')
          ${eventClause}
        ORDER BY oi.item_name, o.customer_name
      `, params);
      rows = result.rows;
    }
  }

  res.render('admin/reports/customizations', {
    title: 'Customization Detail',
    allStores: allStores.rows,
    storeId, eventId, store, events, rows,
  });
});

// Sort/distribution: per garment-variant, list customers who ordered it
router.get('/reports/sort', requireAdmin, async (req, res) => {
  const allStores = await db.query('SELECT id, name, active FROM stores ORDER BY active DESC, name');
  const storeId = req.query.store_id ? parseInt(req.query.store_id) : null;
  const eventId = req.query.event_id ? parseInt(req.query.event_id) : null;

  let store = null, events = [], grouped = [];
  if (storeId) {
    const sr = await db.query('SELECT * FROM stores WHERE id = $1', [storeId]);
    store = sr.rows[0] || null;
    if (store) {
      const er = await db.query('SELECT * FROM pickup_events WHERE store_id = $1 ORDER BY event_date', [storeId]);
      events = er.rows;

      const params = [storeId];
      let eventClause = '';
      if (eventId) { params.push(eventId); eventClause = ' AND o.pickup_event_id = $2'; }

      const result = await db.query(`
        SELECT oi.item_name, oi.color_name, oi.size_name, oi.quantity,
               oi.personalization_name, oi.personalization_number,
               o.id AS order_id, o.customer_name
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        WHERE o.store_id = $1
          AND o.status = 'paid'
          ${eventClause}
        ORDER BY oi.item_name, oi.color_name, oi.size_name, o.customer_name
      `, params);

      // Group by item × color × size
      const map = new Map();
      for (const r of result.rows) {
        const key = `${r.item_name}||${r.color_name || ''}||${r.size_name || ''}`;
        if (!map.has(key)) {
          map.set(key, {
            item_name: r.item_name,
            color_name: r.color_name || '',
            size_name: r.size_name || '',
            total_qty: 0,
            entries: [],
          });
        }
        const g = map.get(key);
        g.total_qty += r.quantity;
        g.entries.push(r);
      }
      grouped = [...map.values()];
    }
  }

  res.render('admin/reports/sort', {
    title: 'Sort / Distribution',
    allStores: allStores.rows,
    storeId, eventId, store, events, grouped,
  });
});

// ─── Contact Submissions ─────────────────────────────────────────────────────
router.get('/contact-submissions', requireAdmin, async (req, res) => {
  const result = await db.query(
    'SELECT * FROM contact_submissions ORDER BY created_at DESC LIMIT 200'
  );
  res.render('admin/contact-submissions', { title: 'Contact Submissions', submissions: result.rows });
});

router.post('/settings/password', requireAdmin, async (req, res) => {
  const current = req.body.current_password || '';
  const next1   = req.body.new_password || '';
  const next2   = req.body.confirm_password || '';

  if (!current || !next1 || !next2) {
    req.session.flash = { type: 'error', message: 'All three fields are required.' };
    return res.redirect('/admin/settings');
  }
  if (next1 !== next2) {
    req.session.flash = { type: 'error', message: 'New passwords do not match.' };
    return res.redirect('/admin/settings');
  }
  if (next1.length < 8) {
    req.session.flash = { type: 'error', message: 'New password must be at least 8 characters.' };
    return res.redirect('/admin/settings');
  }

  const settings = await siteSettings.load();
  const effectiveHash = settings.site.adminPasswordHash || config.admin.passwordHash;
  const match = effectiveHash ? await bcrypt.compare(current, effectiveHash) : false;
  if (!match) {
    req.session.flash = { type: 'error', message: 'Current password is incorrect.' };
    return res.redirect('/admin/settings');
  }

  const newHash = await bcrypt.hash(next1, 10);
  await db.query('UPDATE site_settings SET admin_password_hash = $1 WHERE id = 1', [newHash]);
  siteSettings.invalidate();
  req.session.flash = { type: 'success', message: 'Password changed.' };
  res.redirect('/admin/settings');
});

// JSON endpoint for the "Test connection" Square button.
// Lists locations using the currently saved access token + environment.
router.post('/settings/test-square', requireAdmin, async (req, res) => {
  const square = await getSquareConfig();
  if (!square.accessToken) return res.json({ status: 'failed', error: 'No access token saved. Fill it in and save first.' });

  try {
    const { Client, Environment } = require('square');
    const client = new Client({
      accessToken: square.accessToken,
      environment: square.environment === 'production' ? Environment.Production : Environment.Sandbox,
    });
    const { result } = await client.locationsApi.listLocations();
    const locations = (result.locations || []).map(l => ({
      id: l.id,
      name: l.name,
      address: l.address ? [l.address.addressLine1, l.address.locality, l.address.administrativeDistrictLevel1].filter(Boolean).join(', ') : '',
      status: l.status,
    }));
    res.json({ status: 'ok', environment: square.environment, locations });
  } catch (err) {
    // Square SDK errors expose .errors[]; fall back to .message
    const detail = (err.errors && err.errors[0] && err.errors[0].detail) || err.message || String(err);
    res.json({ status: 'failed', error: detail });
  }
});

// JSON endpoint for the "Send test email" button on the settings page.
router.post('/settings/test-email', requireAdmin, async (req, res) => {
  const to = (req.body.to || '').trim();
  if (!to) return res.json({ status: 'failed', error: 'Recipient required' });
  const settings = await siteSettings.load();
  const result = await sendTestEmail({ to, brandName: settings.brand.name });
  res.json(result);
});

// ─── Site Settings (theme + logo + company info + content) ──────────────────
router.get('/settings', requireAdmin, async (req, res) => {
  const result = await db.query('SELECT * FROM site_settings WHERE id = 1');
  res.render('admin/settings', { title: 'Site Settings', settings: result.rows[0] || {} });
});

router.post('/settings', requireAdmin, upload.single('logo'), csrfCheck, async (req, res) => {
  const {
    brand_name, brand_tagline, brand_color, about_blurb,
    company_phone, company_address, company_email,
    facebook_url, privacy_policy_html, contact_recipient_email,
    maintenance_enabled, maintenance_message,
    smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, smtp_secure,
    square_environment, square_access_token, square_location_id,
    pickup_reminder_hours,
    clear_logo,
  } = req.body;

  // Logo: new upload wins, then "clear" checkbox, otherwise keep existing.
  // existing_logo is round-tripped through the form so we sanitize it.
  let logo_url;
  if (req.file) {
    logo_url = `/uploads/${req.file.filename}`;
  } else if (clear_logo === 'on') {
    logo_url = '';
  } else {
    logo_url = safeUrl(req.body.existing_logo);
  }

  // For credential fields (smtp_pass, square_access_token), blank submission means
  // "keep what's already saved". Read the current row first and merge.
  const cur = (await db.query('SELECT smtp_pass, square_access_token FROM site_settings WHERE id = 1')).rows[0] || {};
  const finalSmtpPass = (smtp_pass && smtp_pass.length > 0) ? smtp_pass : (cur.smtp_pass || '');
  const finalSquareToken = (square_access_token && square_access_token.length > 0) ? square_access_token : (cur.square_access_token || '');

  await db.query(
    `UPDATE site_settings SET
       brand_name = $1, brand_tagline = $2, brand_color = $3, logo_url = $4,
       about_blurb = $5, company_phone = $6, company_address = $7, company_email = $8,
       facebook_url = $9, privacy_policy_html = $10, contact_recipient_email = $11,
       maintenance_enabled = $12, maintenance_message = $13,
       smtp_host = $14, smtp_port = $15, smtp_user = $16, smtp_pass = $17,
       smtp_from = $18, smtp_secure = $19,
       square_environment = $20, square_access_token = $21, square_location_id = $22,
       pickup_reminder_hours = $23,
       updated_at = NOW()
     WHERE id = 1`,
    [
      brand_name || 'GS Graphics',
      brand_tagline || '',
      (brand_color && /^#[0-9a-fA-F]{6}$/.test(brand_color)) ? brand_color : '#2e7d32',
      logo_url,
      sanitizeRichText(about_blurb || ''),
      company_phone || '',
      company_address || '',
      company_email || '',
      safeUrl(facebook_url),
      sanitizeRichText(privacy_policy_html || ''),
      contact_recipient_email || '',
      maintenance_enabled === 'on',
      maintenance_message || '',
      smtp_host || '',
      parseInt(smtp_port) || 587,
      smtp_user || '',
      finalSmtpPass,
      smtp_from || '',
      smtp_secure === 'on',
      square_environment === 'production' ? 'production' : 'sandbox',
      finalSquareToken,
      square_location_id || '',
      Math.max(1, Math.min(parseInt(pickup_reminder_hours) || 24, 168)),
    ]
  );

  siteSettings.invalidate();
  req.session.flash = { type: 'success', message: 'Site settings saved.' };
  res.redirect('/admin/settings');
});

module.exports = router;

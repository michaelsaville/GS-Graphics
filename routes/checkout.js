const express = require('express');
const router  = express.Router();
const db      = require('../db');
const config  = require('../config');
const { v4: uuidv4 } = require('uuid');
const { computeCartTotals } = require('./store');
const siteSettings = require('../site-settings');
const { getSquareConfig } = require('../square-config');
const { sendCustomerOrderReceipt, sendOperatorOrderAlert } = require('../mailer');

function getCart(req) {
  if (!req.session.cart) req.session.cart = [];
  return req.session.cart;
}

// Best-effort post-order notifications. Sends customer receipt + operator alert.
// Logs but never throws — checkout flow must not fail because of email.
async function sendOrderNotifications(orderId) {
  try {
    const orderRow = await db.query(
      `SELECT o.*, s.name as store_name FROM orders o LEFT JOIN stores s ON o.store_id = s.id WHERE o.id = $1`,
      [orderId]
    );
    const order = orderRow.rows[0];
    if (!order) return;

    const linesRow = await db.query('SELECT * FROM order_items WHERE order_id = $1', [orderId]);
    const settings = await siteSettings.load();
    const subtotal = parseFloat(order.total_amount) - parseFloat(order.tax_amount || 0);
    const tax = parseFloat(order.tax_amount || 0);
    const total = parseFloat(order.total_amount);

    // Customer receipt (only if they gave us an email)
    if (order.customer_email) {
      await sendCustomerOrderReceipt({
        to: order.customer_email,
        customerName: order.customer_name,
        orderId,
        lineItems: linesRow.rows,
        subtotal, tax, total,
        brandName: settings.brand.name,
        baseUrl: config.baseUrl,
      });
    }

    // Operator alert
    await sendOperatorOrderAlert({
      to: settings.site.contactRecipient,
      brandName: settings.brand.name,
      baseUrl: config.baseUrl,
      orderId,
      customerName: order.customer_name,
      customerEmail: order.customer_email || '(no email)',
      total,
      lineCount: linesRow.rows.length,
      storeName: order.store_name,
    });
  } catch (err) {
    console.error(`Order notifications for #${orderId} failed:`, err.message);
  }
}

// ─── Checkout form ────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const cart = getCart(req);
  if (cart.length === 0) return res.redirect('/cart');

  const totals = computeCartTotals(cart);

  // Collect distinct store IDs from cart to load pickup events
  const storeIds = [...new Set(cart.map(c => c.storeId))];
  let events = [];
  if (storeIds.length === 1) {
    const result = await db.query(
      'SELECT * FROM pickup_events WHERE store_id = $1 ORDER BY event_date', [storeIds[0]]
    );
    events = result.rows;
  }

  res.render('checkout/index', { title: 'Checkout', cart, ...totals, events });
});

// ─── Process checkout ─────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const cart = getCart(req);
  if (cart.length === 0) return res.redirect('/cart');

  // Re-check store deadlines at checkout time. A store may have closed since the customer
  // started shopping, in which case we must not create the order.
  const cartStoreIds = [...new Set(cart.map(c => c.storeId))];
  const stores = await db.query(
    'SELECT id, name, slug, active, orders_close_at, order_deadline_message FROM stores WHERE id = ANY($1::int[])',
    [cartStoreIds]
  );
  const closedStore = stores.rows.find(s => !s.active || (s.orders_close_at && new Date() >= new Date(s.orders_close_at)));
  if (closedStore) {
    req.session.flash = {
      type: 'error',
      message: closedStore.order_deadline_message ||
               `Orders for "${closedStore.name}" are now closed. Please remove those items from your cart.`,
    };
    return res.redirect('/cart');
  }

  const {
    customer_name, customer_email, customer_phone, customer_cell,
    customer_address, customer_city, customer_state, customer_zip,
    pickup_event_id
  } = req.body;

  const { subtotal, tax, total } = computeCartTotals(cart);
  const storeId = cart[0].storeId;

  const square = await getSquareConfig();

  // Sandbox short-circuit: when not configured for production OR creds missing,
  // mark order paid immediately without contacting Square. Same UX as before.
  if (!square.isLive) {
    // Create order directly
    const orderResult = await db.query(
      `INSERT INTO orders (store_id, pickup_event_id, customer_name, customer_email, customer_phone, customer_cell,
        customer_address, customer_city, customer_state, customer_zip, status, total_amount, tax_amount, square_payment_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [storeId, pickup_event_id || null, customer_name, customer_email || '', customer_phone || '',
       customer_cell || '', customer_address || '', customer_city || '', customer_state || '',
       customer_zip || '', 'paid', total, tax, `sandbox-${uuidv4().slice(0, 8)}`]
    );

    const orderId = orderResult.rows[0].id;

    // Insert line items
    for (const item of cart) {
      await db.query(
        `INSERT INTO order_items (order_id, item_id, item_name, color_name, size_name, quantity, unit_price,
          personalization_name, personalization_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [orderId, item.itemId, item.itemName, item.colorName || '', item.sizeName || '',
         item.quantity, item.unitPrice, item.personalizationName || '', item.personalizationNumber || '']
      );
    }

    // Clear cart
    req.session.cart = [];

    // Fire-and-forget receipt email; never block the redirect on it
    sendOrderNotifications(orderId);

    return res.redirect(`/checkout/confirmation/${orderId}`);
  }

  // ─── Square Checkout (production flow) ────────────────────────────────────
  // Save pending order first
  const orderResult = await db.query(
    `INSERT INTO orders (store_id, pickup_event_id, customer_name, customer_email, customer_phone, customer_cell,
      customer_address, customer_city, customer_state, customer_zip, status, total_amount, tax_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    [storeId, pickup_event_id || null, customer_name, customer_email || '', customer_phone || '',
     customer_cell || '', customer_address || '', customer_city || '', customer_state || '',
     customer_zip || '', 'pending', total, tax]
  );

  const orderId = orderResult.rows[0].id;

  for (const item of cart) {
    await db.query(
      `INSERT INTO order_items (order_id, item_id, item_name, color_name, size_name, quantity, unit_price,
        personalization_name, personalization_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [orderId, item.itemId, item.itemName, item.colorName || '', item.sizeName || '',
       item.quantity, item.unitPrice, item.personalizationName || '', item.personalizationNumber || '']
    );
  }

  try {
    const { Client, Environment } = require('square');
    const client = new Client({
      accessToken: square.accessToken,
      environment: square.environment === 'production' ? Environment.Production : Environment.Sandbox,
    });

    const lineItems = cart.map(item => ({
      name: `${item.itemName}${item.colorName ? ' - ' + item.colorName : ''}${item.sizeName ? ' (' + item.sizeName + ')' : ''}`,
      quantity: String(item.quantity),
      basePriceMoney: {
        amount: BigInt(Math.round(item.unitPrice * 100)),
        currency: 'USD',
      },
    }));

    const { result } = await client.checkoutApi.createPaymentLink({
      idempotencyKey: uuidv4(),
      order: {
        locationId: square.locationId,
        lineItems,
      },
      checkoutOptions: {
        redirectUrl: `${config.baseUrl}/checkout/callback?order_id=${orderId}`,
      },
    });

    // Persist the Square order id so /callback can verify the payment server-side
    // instead of trusting the redirect query string.
    await db.query(
      'UPDATE orders SET square_order_id = $1 WHERE id = $2',
      [result.paymentLink.orderId || '', orderId]
    );

    req.session.cart = [];
    return res.redirect(result.paymentLink.url);
  } catch (err) {
    console.error('Square checkout error:', err);
    // Mark order failed
    await db.query('UPDATE orders SET status = $1 WHERE id = $2', ['failed', orderId]);
    req.session.flash = { type: 'error', message: 'Payment processing failed. Please try again or contact us.' };
    return res.redirect('/checkout');
  }
});

// ─── Square callback ──────────────────────────────────────────────────────────
// The redirect URL is buyer-controllable, so it cannot be trusted. We only use
// order_id as a lookup key; the actual payment status is verified by retrieving
// the order from Square's API and checking that its state is COMPLETED.
router.get('/callback', async (req, res) => {
  const orderId = req.query.order_id;
  if (!orderId) return res.redirect('/');

  const orderRow = await db.query('SELECT id, status, square_order_id FROM orders WHERE id = $1', [orderId]);
  if (!orderRow.rows[0]) return res.redirect('/');
  const order = orderRow.rows[0];

  // Idempotent: if we've already verified and marked paid, just show the confirmation.
  if (order.status === 'paid') {
    req.session.cart = [];
    return res.redirect(`/checkout/confirmation/${orderId}`);
  }

  if (!order.square_order_id) {
    // No Square order id stored — should not happen in production flow. Leave pending.
    return res.redirect(`/checkout/confirmation/${orderId}`);
  }

  try {
    const square = await getSquareConfig();
    const { Client, Environment } = require('square');
    const client = new Client({
      accessToken: square.accessToken,
      environment: square.environment === 'production' ? Environment.Production : Environment.Sandbox,
    });

    const { result } = await client.ordersApi.retrieveOrder(order.square_order_id);
    const squareState = result.order && result.order.state;

    if (squareState === 'COMPLETED') {
      // Pull the payment_id off the Order's tenders so we can refund later if needed
      const paymentId = (result.order.tenders && result.order.tenders[0] && result.order.tenders[0].payment_id) || '';
      await db.query(
        'UPDATE orders SET status = $1, square_payment_id = $2 WHERE id = $3',
        ['paid', paymentId, orderId]
      );
      req.session.cart = [];
      sendOrderNotifications(orderId);
    }
    // Any other state (OPEN, CANCELED, DRAFT, etc.) — leave order pending; confirmation page
    // will show whatever status is current.
  } catch (err) {
    console.error('Square order verification failed:', err);
    // Network or auth failure — do NOT flip to paid. Order stays pending; admin can verify manually.
  }

  return res.redirect(`/checkout/confirmation/${orderId}`);
});

// ─── Order confirmation ───────────────────────────────────────────────────────
router.get('/confirmation/:id', async (req, res) => {
  const order = await db.query(
    `SELECT o.*, s.name as store_name, pe.name as event_name, pe.event_date, pe.event_time, pe.location as event_location
     FROM orders o LEFT JOIN stores s ON o.store_id = s.id
     LEFT JOIN pickup_events pe ON o.pickup_event_id = pe.id
     WHERE o.id = $1`, [req.params.id]
  );
  if (!order.rows[0]) return res.redirect('/');

  const items = await db.query('SELECT * FROM order_items WHERE order_id = $1', [req.params.id]);

  res.render('checkout/confirmation', {
    title: 'Order Confirmation',
    order: order.rows[0],
    items: items.rows,
    cart: getCart(req),
  });
});

module.exports = router;

const nodemailer = require('nodemailer');
const siteSettings = require('./site-settings');

// SMTP config priority: site_settings (DB-edited via /admin/settings) → env vars (fallback).
// Returns null if nothing usable is configured.
async function getSmtpConfig() {
  try {
    const { smtp } = await siteSettings.load();
    if (smtp && smtp.host && smtp.user && smtp.pass) {
      return {
        host: smtp.host,
        port: parseInt(smtp.port) || 587,
        user: smtp.user,
        pass: smtp.pass,
        from: smtp.from || '',
        secure: Boolean(smtp.secure),
        source: 'db',
      };
    }
  } catch (e) { /* fall through to env */ }

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    return {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: process.env.SMTP_FROM || '',
      secure: String(process.env.SMTP_SECURE).toLowerCase() === 'true',
      source: 'env',
    };
  }
  return null;
}

// Cached transporter, keyed on the host/port/user combo so it's recreated when settings change.
let cachedKey = null, cachedTransporter = null;
function transporterFor(cfg) {
  const key = `${cfg.host}|${cfg.port}|${cfg.user}|${cfg.secure}`;
  if (cachedKey === key && cachedTransporter) return cachedTransporter;
  cachedKey = key;
  cachedTransporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  return cachedTransporter;
}

// Convenience: is SMTP usable right now?
async function smtpConfigured() {
  return Boolean(await getSmtpConfig());
}

// Builds the From header from cfg.from, or falls back to `"<brandName>" <user>`.
function fromHeader(cfg, brandName) {
  return cfg.from || `"${brandName || cfg.user}" <${cfg.user}>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Returns { status, error }. status is 'sent' | 'failed' | 'skipped'.
async function sendContactEmail({ to, fromEmail, fromName, subject, text, html, brandName }) {
  if (!to) return { status: 'skipped', error: 'No recipient configured' };
  const cfg = await getSmtpConfig();
  if (!cfg) return { status: 'skipped', error: 'SMTP not configured' };

  try {
    await transporterFor(cfg).sendMail({
      from: fromHeader(cfg, brandName),
      to,
      replyTo: fromEmail ? `"${fromName}" <${fromEmail}>` : undefined,
      subject, text, html,
    });
    return { status: 'sent', error: '' };
  } catch (err) {
    return { status: 'failed', error: err.message || String(err) };
  }
}

async function sendCustomerStatusEmail({ to, customerName, orderId, statusInfo, brandName, note }) {
  if (!to) return { status: 'skipped', error: 'No customer email' };
  const cfg = await getSmtpConfig();
  if (!cfg) return { status: 'skipped', error: 'SMTP not configured' };

  const subject = `Order #${orderId} — ${statusInfo.label}`;
  const greeting = customerName ? `Hi ${customerName},` : 'Hi,';
  const noteBlock = note ? `\n\nNote from ${brandName}: ${note}` : '';
  const text = `${greeting}\n\nYour order #${orderId} status is now: ${statusInfo.label}.${noteBlock}\n\nThanks,\n${brandName}`;
  const html = `<p>${greeting}</p>
<p>Your order <strong>#${orderId}</strong> status is now: <strong>${statusInfo.label}</strong>.</p>
${note ? `<p><em>Note from ${brandName}:</em> ${escapeHtml(note)}</p>` : ''}
<p>Thanks,<br>${brandName}</p>`;

  try {
    await transporterFor(cfg).sendMail({ from: fromHeader(cfg, brandName), to, subject, text, html });
    return { status: 'sent', error: '' };
  } catch (err) {
    return { status: 'failed', error: err.message || String(err) };
  }
}

async function sendCustomerOrderReceipt({ to, customerName, orderId, lineItems, subtotal, tax, total, brandName, baseUrl }) {
  if (!to) return { status: 'skipped', error: 'No customer email' };
  const cfg = await getSmtpConfig();
  if (!cfg) return { status: 'skipped', error: 'SMTP not configured' };

  const subject = `Order #${orderId} confirmed — ${brandName}`;
  const lines = lineItems.map(li =>
    `  ${li.quantity}× ${li.item_name}${li.color_name ? ' / ' + li.color_name : ''}${li.size_name ? ' (' + li.size_name + ')' : ''}` +
    `${li.personalization_name || li.personalization_number ? ' [' + (li.personalization_name || '') + (li.personalization_number ? ' #' + li.personalization_number : '') + ']' : ''}` +
    ` — $${(parseFloat(li.unit_price) * li.quantity).toFixed(2)}`
  ).join('\n');

  const text = `Hi ${customerName || ''},

Thanks for your order! Here's your receipt.

Order #${orderId}

${lines}

Subtotal: $${subtotal.toFixed(2)}
${tax > 0 ? `Tax: $${tax.toFixed(2)}\n` : ''}Total: $${total.toFixed(2)}

You can track your order at: ${baseUrl}/track

Thanks,
${brandName}`;

  const html = `<p>Hi ${escapeHtml(customerName || '')},</p>
<p>Thanks for your order! Here's your receipt.</p>
<p><strong>Order #${orderId}</strong></p>
<table style="border-collapse:collapse;">
  <thead><tr style="background:#f0f0f0;"><th style="text-align:left;padding:6px;">Qty</th><th style="text-align:left;padding:6px;">Item</th><th style="text-align:right;padding:6px;">Price</th></tr></thead>
  <tbody>
${lineItems.map(li => `    <tr>
      <td style="padding:6px;">${li.quantity}</td>
      <td style="padding:6px;">${escapeHtml(li.item_name)}${li.color_name ? ' / ' + escapeHtml(li.color_name) : ''}${li.size_name ? ' (' + escapeHtml(li.size_name) + ')' : ''}${li.personalization_name || li.personalization_number ? '<br><small><em>' + escapeHtml(li.personalization_name || '') + (li.personalization_number ? ' #' + escapeHtml(li.personalization_number) : '') + '</em></small>' : ''}</td>
      <td style="padding:6px;text-align:right;">$${(parseFloat(li.unit_price) * li.quantity).toFixed(2)}</td>
    </tr>`).join('\n')}
  </tbody>
</table>
<p style="text-align:right;">
  Subtotal: $${subtotal.toFixed(2)}<br>
  ${tax > 0 ? `Tax: $${tax.toFixed(2)}<br>` : ''}
  <strong>Total: $${total.toFixed(2)}</strong>
</p>
<p>You can <a href="${baseUrl}/track">track your order here</a>.</p>
<p>Thanks,<br>${brandName}</p>`;

  try {
    await transporterFor(cfg).sendMail({ from: fromHeader(cfg, brandName), to, subject, text, html });
    return { status: 'sent', error: '' };
  } catch (err) {
    return { status: 'failed', error: err.message || String(err) };
  }
}

async function sendOperatorOrderAlert({ to, brandName, baseUrl, orderId, customerName, customerEmail, total, lineCount, storeName }) {
  if (!to) return { status: 'skipped', error: 'No operator recipient' };
  const cfg = await getSmtpConfig();
  if (!cfg) return { status: 'skipped', error: 'SMTP not configured' };

  const subject = `New order #${orderId} — ${storeName || 'unknown store'} — $${total.toFixed(2)}`;
  const text = `New paid order just landed.

Order #${orderId}
Store: ${storeName || '—'}
Customer: ${customerName} <${customerEmail}>
Total: $${total.toFixed(2)} (${lineCount} line${lineCount === 1 ? '' : 's'})

Open it: ${baseUrl}/admin/orders/${orderId}`;

  const html = `<p>New paid order just landed.</p>
<p><strong>Order #${orderId}</strong><br>
Store: ${escapeHtml(storeName || '—')}<br>
Customer: ${escapeHtml(customerName)} &lt;${escapeHtml(customerEmail)}&gt;<br>
Total: <strong>$${total.toFixed(2)}</strong> (${lineCount} line${lineCount === 1 ? '' : 's'})</p>
<p><a href="${baseUrl}/admin/orders/${orderId}">Open this order &rarr;</a></p>`;

  try {
    await transporterFor(cfg).sendMail({ from: fromHeader(cfg, brandName), to, subject, text, html });
    return { status: 'sent', error: '' };
  } catch (err) {
    return { status: 'failed', error: err.message || String(err) };
  }
}

// One-off test send used by the admin "Send test" button.
async function sendTestEmail({ to, brandName }) {
  if (!to) return { status: 'failed', error: 'Recipient required' };
  const cfg = await getSmtpConfig();
  if (!cfg) return { status: 'failed', error: 'SMTP not configured — fill in host/user/password and save first.' };

  try {
    await transporterFor(cfg).sendMail({
      from: fromHeader(cfg, brandName),
      to,
      subject: `${brandName || 'Site'} — SMTP test`,
      text: `If you can read this, outbound email is working from ${brandName || 'your site'}.\n\nSent via ${cfg.host}:${cfg.port} as ${cfg.user}.`,
      html: `<p>If you can read this, outbound email is working from <strong>${escapeHtml(brandName || 'your site')}</strong>.</p>
             <p>Sent via <code>${escapeHtml(cfg.host)}:${cfg.port}</code> as <code>${escapeHtml(cfg.user)}</code>.</p>`,
    });
    return { status: 'sent', error: '' };
  } catch (err) {
    return { status: 'failed', error: err.message || String(err) };
  }
}

module.exports = {
  sendContactEmail, sendCustomerStatusEmail, sendCustomerOrderReceipt,
  sendOperatorOrderAlert, sendTestEmail, smtpConfigured, getSmtpConfig,
};

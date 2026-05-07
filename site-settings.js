const db = require('./db');
const config = require('./config');

// Short in-memory cache so we're not hitting the DB on every request.
// Admin edits should call invalidate() to make changes visible immediately.
let cache = null;
let cachedAt = 0;
const TTL_MS = 30 * 1000;

async function load() {
  const now = Date.now();
  if (cache && (now - cachedAt) < TTL_MS) return cache;

  const result = await db.query('SELECT * FROM site_settings WHERE id = 1');
  const row = result.rows[0] || {};

  cache = {
    brand: {
      name:     row.brand_name    || config.brand.name,
      tagline:  row.brand_tagline || config.brand.tagline,
      color:    row.brand_color   || config.brand.color,
      logoUrl:  row.logo_url      || config.brand.logoUrl,
    },
    site: {
      aboutBlurb:        row.about_blurb         || '',
      companyPhone:      row.company_phone       || '',
      companyAddress:    row.company_address     || '',
      companyEmail:      row.company_email       || '',
      facebookUrl:       row.facebook_url        || '',
      privacyPolicyHtml: row.privacy_policy_html || '',
      contactRecipient:  row.contact_recipient_email || '',
      maintenanceEnabled: Boolean(row.maintenance_enabled),
      maintenanceMessage: row.maintenance_message || '',
    },
    smtp: {
      host:   row.smtp_host   || '',
      port:   row.smtp_port   || 587,
      user:   row.smtp_user   || '',
      pass:   row.smtp_pass   || '',
      from:   row.smtp_from   || '',
      secure: Boolean(row.smtp_secure),
    },
    square: {
      environment: row.square_environment  || 'sandbox',
      accessToken: row.square_access_token || '',
      locationId:  row.square_location_id  || '',
    },
  };
  cachedAt = now;
  return cache;
}

function invalidate() {
  cache = null;
  cachedAt = 0;
}

module.exports = { load, invalidate };

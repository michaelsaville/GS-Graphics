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
-- Singleton site_settings row holds editable branding + content + company info.
-- Replaces env-driven brand globals so admin can change colors/logo/copy without redeploy.
CREATE TABLE IF NOT EXISTS site_settings (
  id                       INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  brand_name               VARCHAR(255) DEFAULT 'GS Graphics',
  brand_tagline            VARCHAR(255) DEFAULT 'Custom Apparel for Your School & Team',
  brand_color              VARCHAR(7)   DEFAULT '#2e7d32',
  logo_url                 VARCHAR(512) DEFAULT '',
  about_blurb              TEXT         DEFAULT '',
  company_phone            VARCHAR(50)  DEFAULT '',
  company_address          VARCHAR(512) DEFAULT '',
  company_email            VARCHAR(255) DEFAULT '',
  facebook_url             VARCHAR(512) DEFAULT '',
  privacy_policy_html      TEXT         DEFAULT '',
  contact_recipient_email  VARCHAR(255) DEFAULT '',
  updated_at               TIMESTAMPTZ  DEFAULT NOW()
);

INSERT INTO site_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Submissions from /contact. Persisted regardless of email-send outcome so nothing is lost.
CREATE TABLE IF NOT EXISTS contact_submissions (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(255) NOT NULL,
  email        VARCHAR(255) NOT NULL,
  message      TEXT NOT NULL,
  email_status VARCHAR(20) DEFAULT 'pending',  -- pending | sent | failed | skipped
  email_error  TEXT DEFAULT '',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_submissions_created ON contact_submissions (created_at DESC);
`;

const PRIVACY_BOILERPLATE = `
<h2>Privacy Policy</h2>
<p><em>Last updated: replace with date when reviewed.</em></p>

<p>This page explains what information we collect when you use this website and what we do with it. Please read this in conjunction with anything else our team has shared with you. If you have any questions, contact us using the information on our Contact page.</p>

<h3>Information we collect</h3>
<p>When you place an order, we collect the information you enter on the order form: your name, email address, phone numbers, shipping or pickup address, the items you order, and any personalization details (such as a name or number to print). We also collect basic technical information your browser sends automatically (such as your IP address and browser type) for security and troubleshooting purposes.</p>

<h3>How we use it</h3>
<p>We use the information you provide to fulfill your order, contact you about your order if needed, and keep accurate business records. We do not sell, rent, or share your personal information with third parties for their marketing purposes.</p>

<h3>Payment processing</h3>
<p>Card payments are processed by our payment provider, Square. We never see or store your full card number. Square's privacy policy applies to payment-related data they collect; please review it on Square's website.</p>

<h3>Cookies and sessions</h3>
<p>We use a session cookie to remember the contents of your shopping cart while you browse. The session cookie expires when you close your browser or after a period of inactivity. We do not use third-party advertising or tracking cookies.</p>

<h3>How long we keep your information</h3>
<p>We retain order records as long as required for tax, accounting, and customer-service purposes. You can request a copy of, or deletion of, your personal data by contacting us.</p>

<h3>Children</h3>
<p>This website is not directed to children under 13, and we do not knowingly collect personal information from children under 13. Orders placed for children's items must be placed by an adult.</p>

<h3>Changes to this policy</h3>
<p>We may update this policy from time to time. The "last updated" date at the top of this page reflects the latest revision. Material changes will be highlighted on this page.</p>

<h3>Contact</h3>
<p>If you have questions about this policy or about your data, please contact us using the details on our Contact page.</p>
`.trim();

async function migrate() {
  try {
    console.log('Running migration 005: site_settings + contact_submissions ...');
    await pool.query(SQL);

    // Seed privacy boilerplate only if it's still empty (don't clobber edits)
    const existing = await pool.query('SELECT privacy_policy_html FROM site_settings WHERE id = 1');
    if (!existing.rows[0] || !existing.rows[0].privacy_policy_html) {
      await pool.query('UPDATE site_settings SET privacy_policy_html = $1 WHERE id = 1', [PRIVACY_BOILERPLATE]);
      console.log('Seeded privacy policy boilerplate.');
    } else {
      console.log('Privacy policy already populated, leaving it alone.');
    }

    console.log('Migration 005 complete.');
  } catch (err) {
    console.error('Migration 005 failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();

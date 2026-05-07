const express      = require('express');
const session      = require('express-session');
const pgSession    = require('connect-pg-simple')(session);
const helmet       = require('helmet');
const path         = require('path');
const config       = require('./config');
const { pool }     = require('./db');
const { csrfMiddleware } = require('./csrf');
const siteSettings = require('./site-settings');
const orderStatus = require('./order-status');

const app = express();

// nginx terminates TLS in front of us; trust its X-Forwarded-* headers so
// req.secure / req.ip are correct, and so secure: true cookies actually fire.
app.set('trust proxy', 1);

// ─── Security headers ────────────────────────────────────────────────────────
// CSP allows: jsdelivr (Quill rich-text editor), maps.google.com (Contact iframe),
// data: images, https: images. 'unsafe-inline' for scripts/styles is needed because
// admin pages have inline event handlers and Quill writes inline styles. A nonce-based
// CSP would be tighter but requires reworking every inline <script>.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      styleSrc:    ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      imgSrc:      ["'self'", "data:", "https:"],
      fontSrc:     ["'self'", "data:", "https://cdn.jsdelivr.net"],
      frameSrc:    ["https://maps.google.com", "https://www.google.com"],
      connectSrc:  ["'self'"],
      objectSrc:   ["'none'"],
      baseUri:     ["'self'"],
      formAction:  ["'self'", "https://*.squareup.com", "https://*.square.com"],
      frameAncestors: ["'none'"],
    },
  },
  // HSTS, X-Content-Type-Options, X-Frame-Options=DENY, Referrer-Policy default-on
  crossOriginEmbedderPolicy: false,  // we embed Google Maps which doesn't send CORP
  crossOriginResourcePolicy: { policy: 'cross-origin' },  // logos may be hotlinked
}));

// ─── View Engine ──────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ─── Static Files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ─── Sessions ─────────────────────────────────────────────────────────────────
app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: config.session.secret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',  // requires trust proxy + HTTPS
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  },
}));

// ─── CSRF ────────────────────────────────────────────────────────────────────
// Multipart routes (upload forms) defer enforcement to a per-route check that
// runs after multer — see csrfCheck usage in routes/admin.js.
app.use(csrfMiddleware);

// ─── Template Globals ─────────────────────────────────────────────────────────
app.use(async (req, res, next) => {
  try {
    const settings = await siteSettings.load();
    res.locals.brand = settings.brand;
    res.locals.site  = settings.site;
  } catch (err) {
    // If DB read fails, fall back to env so the page can still render
    console.error('site_settings load failed:', err.message);
    res.locals.brand = config.brand;
    res.locals.site  = { aboutBlurb: '', companyPhone: '', companyAddress: '', companyEmail: '', facebookUrl: '', privacyPolicyHtml: '', contactRecipient: '' };
  }
  res.locals.baseUrl       = config.baseUrl;
  res.locals.adminLoggedIn = req.session.adminLoggedIn || false;
  res.locals.flash         = req.session.flash || null;
  res.locals.orderStatus   = orderStatus;
  delete req.session.flash;
  next();
});

// ─── Maintenance gate ────────────────────────────────────────────────────────
// When maintenance is on, only /admin and /uploads are reachable. Everything
// else gets the maintenance page so the operator can keep working.
app.use((req, res, next) => {
  if (!res.locals.site || !res.locals.site.maintenanceEnabled) return next();
  if (req.session.adminLoggedIn) return next();
  if (req.path.startsWith('/admin') || req.path.startsWith('/uploads') || req.path.startsWith('/css') || req.path === '/favicon.svg') return next();
  res.status(503).render('store/maintenance', {
    title: 'Back Soon',
    cart: [],
    message: res.locals.site.maintenanceMessage,
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/admin',          require('./routes/admin'));
app.use('/checkout',       require('./routes/checkout'));
app.use('/api/cron',       require('./routes/cron'));
app.use('/',               require('./routes/store'));

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('store/404', { title: 'Page Not Found' });
});

// ─── Error Handler ────────────────────────────────────────────────────────────
// Always log full stack server-side. Show generic message in production so we
// don't leak internals (paths, query fragments, library names) to visitors.
app.use((err, req, res, next) => {
  console.error(err.stack);
  const isProd = process.env.NODE_ENV === 'production';
  const userMessage = isProd
    ? 'Something went wrong. Please try again, or contact us if the problem persists.'
    : (err.message || 'Server error');
  res.status(500).render('store/error', { title: 'Server Error', error: userMessage });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`GS-Graphics running on port ${config.port}`);
  console.log(`Base URL: ${config.baseUrl}`);
  console.log(`Admin:    ${config.baseUrl}/admin`);
});

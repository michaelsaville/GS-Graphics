const express      = require('express');
const session      = require('express-session');
const pgSession    = require('connect-pg-simple')(session);
const path         = require('path');
const config       = require('./config');
const { pool }     = require('./db');
const { csrfMiddleware } = require('./csrf');
const siteSettings = require('./site-settings');
const orderStatus = require('./order-status');

const app = express();

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
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8 hours
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
app.use('/admin',    require('./routes/admin'));
app.use('/checkout', require('./routes/checkout'));
app.use('/',         require('./routes/store'));

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('store/404', { title: 'Page Not Found' });
});

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('store/error', { title: 'Server Error', error: err.message });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(config.port, () => {
  console.log(`GS-Graphics running on port ${config.port}`);
  console.log(`Base URL: ${config.baseUrl}`);
  console.log(`Admin:    ${config.baseUrl}/admin`);
});

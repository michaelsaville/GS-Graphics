const express      = require('express');
const session      = require('express-session');
const pgSession    = require('connect-pg-simple')(session);
const path         = require('path');
const config       = require('./config');
const { pool }     = require('./db');

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

// ─── Template Globals ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.locals.brand        = config.brand;
  res.locals.baseUrl      = config.baseUrl;
  res.locals.adminLoggedIn = req.session.adminLoggedIn || false;
  res.locals.flash        = req.session.flash || null;
  delete req.session.flash;
  next();
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

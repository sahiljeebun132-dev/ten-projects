'use strict';
/**
 * Northwind Goods - DEMO STORE
 * ---------------------------------------------------------------
 * A learning project. The shop, the brand and the checkout are all
 * fictional. Payment is simulated in-process: no card data leaves
 * the form, no payment provider is contacted, nothing is charged.
 */
require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const methodOverride = require('method-override');

const { db, isInitialised, DB_PATH } = require('./db');
const csrf = require('./middleware/csrf');
const flash = require('./middleware/flash');
const cart = require('./middleware/cart');
const { formatMoney } = require('./middleware/pricing');

const app = express();
const PORT = Number(process.env.PORT) || 4005;

if (!process.env.SESSION_SECRET) {
  console.warn('[warn] SESSION_SECRET is not set - using an insecure demo default.');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '64kb' }));
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.use(
  session({
    name: 'northwind.sid',
    secret: process.env.SESSION_SECRET || 'demo-only-insecure-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

app.use(flash);

// Small set of view locals shared by every template.
app.use((req, res, next) => {
  res.locals.user = (req.session && req.session.user) || null;
  res.locals.cartCount = req.session ? cart.cartCount(req) : 0;
  res.locals.money = formatMoney;
  res.locals.currentPath = req.path;
  res.locals.query = req.query || {};
  res.locals.storeName = 'Northwind Goods';
  res.locals.demoBanner = 'Demo store - simulated payments only. Nothing here is real and no money changes hands.';
  res.locals.navCategories = db
    .prepare('SELECT name, slug FROM categories ORDER BY name')
    .all();
  res.locals.title = 'Northwind Goods (demo store)';
  next();
});

// CSRF runs after the shared locals so its own rejection page can render the layout.
app.use(csrf);


app.use('/', require('./routes/shop'));
app.use('/cart', require('./routes/cart'));
app.use('/', require('./routes/auth'));
app.use('/account', require('./routes/account'));
app.use('/checkout', require('./routes/checkout'));
app.use('/admin', require('./routes/admin'));

// 404
app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Page not found',
    status: 404,
    message: 'We could not find that page in the demo catalogue.'
  });
});

// Errors
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);

  // If the failure happened before the shared locals were set, fill in enough
  // for the error page to still render rather than failing a second time.
  if (res.locals.navCategories === undefined) {
    res.locals.user = res.locals.user || null;
    res.locals.cartCount = res.locals.cartCount || 0;
    res.locals.money = formatMoney;
    res.locals.currentPath = req.path;
    res.locals.query = req.query || {};
    res.locals.csrfToken = res.locals.csrfToken || '';
    res.locals.navCategories = [];
  }

  res.status(err.status || 500).render('error', {
    title: 'Something went wrong',
    status: err.status || 500,
    message:
      process.env.NODE_ENV === 'production'
        ? 'Something went wrong on the demo server.'
        : String((err && err.message) || err)
  });
});

if (require.main === module) {
  if (!isInitialised()) {
    console.error(
      '\nThe database has not been seeded yet.\n' +
      'Run:  npm run seed\n' +
      `(expected file: ${DB_PATH})\n`
    );
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`Northwind Goods DEMO store listening on http://localhost:${PORT}`);
    console.log('Simulated checkout only - no real payments are processed.');
  });
}

module.exports = app;

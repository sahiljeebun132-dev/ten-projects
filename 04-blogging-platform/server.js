'use strict';

require('dotenv').config({ quiet: true });

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const methodOverride = require('method-override');

const { applied, DB_FILE } = require('./db');
const { loadUser } = require('./middleware/auth');
const { flash } = require('./middleware/flash');
const { csrfToken, verifyCsrf } = require('./middleware/csrf');
const { notFound, errorHandler } = require('./middleware/errors');
const { slugify } = require('./lib/content');

const publicRoutes = require('./routes/public');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const commentRoutes = require('./routes/comments');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

if (IS_PROD && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET must be set when NODE_ENV=production.');
  process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

/* ------------------------------------------------------------------ *
 * App setup
 * ------------------------------------------------------------------ */
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Baseline security headers (kept small; add helmet for a fuller set).
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'same-origin');
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'self'; base-uri 'self'"
  );
  next();
});

app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(methodOverride('_method'));

app.use(
  session({
    name: 'blog.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
    }
  })
);

app.use(
  '/uploads',
  express.static(path.join(__dirname, 'public', 'uploads'), {
    maxAge: '7d',
    index: false,
    dotfiles: 'ignore',
    setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff')
  })
);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: IS_PROD ? '7d' : 0, index: false }));

/* Template helpers. Set on app.locals so that *every* render — including the
   error page rendered from middleware that runs before the routes — has them. */
app.locals.siteTitle = process.env.SITE_TITLE || 'Inkwell';
app.locals.siteDescription =
  process.env.SITE_DESCRIPTION || 'Notes on building things with Node, SQLite and a bit of markdown.';
app.locals.slugify = slugify;
app.locals.currentUser = null;
app.locals.flash = null;
app.locals.csrfToken = '';
app.locals.formatDate = (value) => {
  if (!value) return '';
  const raw = String(value);
  const date = new Date(raw.replace(' ', 'T') + (raw.endsWith('Z') ? '' : 'Z'));
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
};

app.use((req, res, next) => {
  res.locals.currentPath = req.path;
  next();
});

app.use(loadUser);
app.use(flash);
app.use(csrfToken);
app.use(verifyCsrf);

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */
app.use('/', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/', commentRoutes);
app.use('/', publicRoutes);

app.use(notFound);
app.use(errorHandler);

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`\n  ${siteTitle()} running at http://localhost:${PORT}`);
    console.log(`  database: ${DB_FILE}${applied ? ' (schema applied)' : ''}`);
    console.log(`  mode: ${IS_PROD ? 'production' : 'development'}\n`);
    if (!process.env.SESSION_SECRET) {
      console.warn('  WARNING: SESSION_SECRET is not set — using a random secret; sessions reset on restart.\n');
    }
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function siteTitle() {
  return process.env.SITE_TITLE || 'Inkwell';
}

module.exports = app;

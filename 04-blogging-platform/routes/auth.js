'use strict';

const express = require('express');
const Users = require('../models/user');
const { requireGuest } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// 5 failed attempts per IP+email per 15 minutes.
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many login attempts. Please wait a few minutes and try again.'
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* Register ---------------------------------------------------------------- */
router.get('/register', requireGuest, (req, res) => {
  res.render('auth/register', { title: 'Register', errors: [], values: {} });
});

router.post('/register', requireGuest, (req, res, next) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 120);
  const password = String(req.body.password || '');
  const password2 = String(req.body.password2 || '');

  const errors = [];
  if (name.length < 2) errors.push('Please enter a display name of at least 2 characters.');
  if (!EMAIL_RE.test(email)) errors.push('Please enter a valid email address.');
  if (password.length < 8) errors.push('Passwords must be at least 8 characters long.');
  if (password !== password2) errors.push('The two passwords do not match.');
  if (!errors.length && Users.findByEmail(email)) errors.push('That email address is already registered.');

  if (errors.length) {
    return res.status(400).render('auth/register', { title: 'Register', errors, values: { name, email } });
  }

  // The very first account bootstraps the site as an admin.
  const role = Users.count() === 0 ? 'admin' : 'author';
  const user = Users.create({ name, email, password, role });

  return req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = Users.toSession(user);
    req.session.flash = { type: 'success', message: `Welcome, ${user.name}! Your account is ready.` };
    res.redirect('/dashboard');
  });
});

/* Login -------------------------------------------------------------------- */
router.get('/login', requireGuest, (req, res) => {
  res.render('auth/login', { title: 'Log in', error: null, values: {} });
});

router.post('/login', requireGuest, loginLimiter, (req, res, next) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = Users.findByEmail(email);

  if (!user || !Users.verifyPassword(user, password)) {
    return res.status(401).render('auth/login', {
      title: 'Log in',
      error: 'Incorrect email or password.',
      values: { email }
    });
  }

  loginLimiter.reset(req);
  const returnTo = req.session.returnTo;

  return req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = Users.toSession(user);
    req.session.flash = { type: 'success', message: `Signed in as ${user.name}.` };
    res.redirect(returnTo && returnTo.startsWith('/') ? returnTo : '/dashboard');
  });
});

/* Logout ------------------------------------------------------------------- */
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('blog.sid');
    res.redirect('/');
  });
});

module.exports = router;

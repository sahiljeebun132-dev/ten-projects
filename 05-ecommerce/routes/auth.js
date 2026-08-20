'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const cart = require('../middleware/cart');
const { redirectIfLoggedIn } = require('../middleware/auth');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function safeReturnTo(req, fallback = '/account') {
  const t = req.session.returnTo;
  delete req.session.returnTo;
  if (typeof t === 'string' && t.startsWith('/') && !t.startsWith('//')) return t;
  return fallback;
}

function signIn(req, user) {
  // Merge the guest basket before the session identity changes.
  cart.mergeSessionCartIntoUser(req, user.id);
  req.session.user = { id: user.id, email: user.email, name: user.name, role: user.role };
}

// ---------------------------------------------------------------- register
router.get('/register', redirectIfLoggedIn, (req, res) => {
  res.render('register', { title: 'Create a demo account', form: {}, errors: [] });
});

router.post('/register', redirectIfLoggedIn, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm_password || '');

  const errors = [];
  if (name.length < 2) errors.push('Please enter your name.');
  if (!EMAIL_RE.test(email)) errors.push('Please enter a valid email address.');
  if (password.length < 8) errors.push('Password must be at least 8 characters.');
  if (password !== confirm) errors.push('Passwords do not match.');

  if (!errors.length) {
    const taken = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (taken) errors.push('An account with that email already exists.');
  }

  if (errors.length) {
    return res.status(400).render('register', {
      title: 'Create a demo account',
      form: { name, email },
      errors
    });
  }

  const hash = bcrypt.hashSync(password, 10);
  const id = db
    .prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)')
    .run(email, hash, name, 'customer').lastInsertRowid;

  signIn(req, { id, email, name, role: 'customer' });
  req.flash('success', `Welcome, ${name}. This is a demo account on a demo store.`);
  res.redirect(safeReturnTo(req));
});

// ------------------------------------------------------------------- login
router.get('/login', redirectIfLoggedIn, (req, res) => {
  res.render('login', { title: 'Sign in - demo store', form: {}, errors: [] });
});

router.post('/login', redirectIfLoggedIn, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
  const password = String(req.body.password || '');

  const user = db
    .prepare('SELECT id, email, name, role, password_hash FROM users WHERE email = ?')
    .get(email);

  // Same message either way, so the form does not reveal which emails exist.
  const ok = user && bcrypt.compareSync(password, user.password_hash);
  if (!ok) {
    return res.status(401).render('login', {
      title: 'Sign in - demo store',
      form: { email },
      errors: ['Email or password is incorrect.']
    });
  }

  signIn(req, user);
  req.flash('success', `Signed in as ${user.name}.`);
  res.redirect(safeReturnTo(req, user.role === 'admin' ? '/admin' : '/account'));
});

// ------------------------------------------------------------------ logout
router.post('/logout', (req, res) => {
  const returnTo = '/';
  req.session.destroy(() => {
    res.clearCookie('northwind.sid');
    res.redirect(returnTo);
  });
});

module.exports = router;

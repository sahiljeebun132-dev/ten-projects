'use strict';
const express = require('express');
const { db } = require('../db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin);

function addressesFor(userId) {
  return db
    .prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC')
    .all(userId);
}

function validateAddress(body) {
  const a = {
    label: String(body.label || 'Home').trim().slice(0, 40) || 'Home',
    full_name: String(body.full_name || '').trim().slice(0, 100),
    line1: String(body.line1 || '').trim().slice(0, 160),
    line2: String(body.line2 || '').trim().slice(0, 160) || null,
    city: String(body.city || '').trim().slice(0, 80),
    region: String(body.region || '').trim().slice(0, 80) || null,
    postal_code: String(body.postal_code || '').trim().slice(0, 20),
    country: String(body.country || 'US').trim().toUpperCase().slice(0, 2),
    phone: String(body.phone || '').trim().slice(0, 40) || null,
    is_default: body.is_default ? 1 : 0
  };
  const errors = [];
  if (a.full_name.length < 2) errors.push('Recipient name is required.');
  if (a.line1.length < 3) errors.push('Address line 1 is required.');
  if (a.city.length < 2) errors.push('City is required.');
  if (a.postal_code.length < 3) errors.push('Postal / ZIP code is required.');
  if (!/^[A-Z]{2}$/.test(a.country)) errors.push('Country must be a two-letter code (e.g. US, GB).');
  return { address: a, errors };
}

function saveAddress(userId, a) {
  const insert = db.transaction(() => {
    if (a.is_default) {
      db.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').run(userId);
    }
    return db.prepare(`
      INSERT INTO addresses (user_id, label, full_name, line1, line2, city, region, postal_code, country, phone, is_default)
      VALUES (@user_id, @label, @full_name, @line1, @line2, @city, @region, @postal_code, @country, @phone, @is_default)
    `).run({ ...a, user_id: userId }).lastInsertRowid;
  });
  return insert();
}

// --------------------------------------------------------------- dashboard
router.get('/', (req, res) => {
  const uid = req.session.user.id;
  const orders = db.prepare(`
    SELECT id, order_number, status, total_cents, placed_at,
           (SELECT SUM(quantity) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
    FROM orders o WHERE user_id = ? ORDER BY placed_at DESC, id DESC LIMIT 5
  `).all(uid);

  res.render('account/dashboard', {
    title: 'Your account - demo store',
    orders,
    addresses: addressesFor(uid),
    reviewCount: db.prepare('SELECT COUNT(*) n FROM reviews WHERE user_id = ?').get(uid).n
  });
});

// --------------------------------------------------------------- addresses
router.get('/addresses', (req, res) => {
  res.render('account/addresses', {
    title: 'Your addresses - demo store',
    addresses: addressesFor(req.session.user.id),
    form: {},
    errors: []
  });
});

router.post('/addresses', (req, res) => {
  const { address, errors } = validateAddress(req.body);
  if (errors.length) {
    return res.status(400).render('account/addresses', {
      title: 'Your addresses - demo store',
      addresses: addressesFor(req.session.user.id),
      form: address,
      errors
    });
  }
  saveAddress(req.session.user.id, address);
  req.flash('success', 'Address saved.');
  res.redirect('/account/addresses');
});

router.post('/addresses/:id/default', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const uid = req.session.user.id;
  const owned = db.prepare('SELECT id FROM addresses WHERE id = ? AND user_id = ?').get(id, uid);
  if (owned) {
    db.transaction(() => {
      db.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').run(uid);
      db.prepare('UPDATE addresses SET is_default = 1 WHERE id = ? AND user_id = ?').run(id, uid);
    })();
    req.flash('success', 'Default delivery address updated.');
  } else {
    req.flash('error', 'Address not found.');
  }
  res.redirect('/account/addresses');
});

router.delete('/addresses/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const info = db.prepare('DELETE FROM addresses WHERE id = ? AND user_id = ?')
    .run(id, req.session.user.id);
  req.flash(info.changes ? 'success' : 'error', info.changes ? 'Address deleted.' : 'Address not found.');
  res.redirect('/account/addresses');
});

// ------------------------------------------------------------------ orders
router.get('/orders', (req, res) => {
  const orders = db.prepare(`
    SELECT id, order_number, status, subtotal_cents, total_cents, placed_at, shipping_method,
           (SELECT SUM(quantity) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
    FROM orders o WHERE user_id = ? ORDER BY placed_at DESC, id DESC
  `).all(req.session.user.id);

  res.render('account/orders', { title: 'Order history - demo store', orders });
});

router.get('/orders/:number', (req, res, next) => {
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ? AND user_id = ?')
    .get(String(req.params.number), req.session.user.id);
  if (!order) return next();

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.id);
  res.render('account/order', {
    title: `Order ${order.order_number} - demo store`,
    order,
    items
  });
});

module.exports = router;

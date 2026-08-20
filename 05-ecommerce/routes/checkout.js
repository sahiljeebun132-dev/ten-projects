'use strict';
/**
 * Multi-step DEMO checkout:  address -> shipping -> simulated payment -> confirmation
 *
 * THE PAYMENT STEP IS A SIMULATION.
 * There is no payment provider, no network call, and no card storage. The form
 * accepts a short list of well-known test card numbers and nothing else; the
 * card number is validated in memory and then discarded. Only a fake brand and
 * the last four digits of the *test* number are written to the order row.
 */
const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const cart = require('../middleware/cart');
const { priceCart, SHIPPING_METHODS } = require('../middleware/pricing');

const router = express.Router();

// ------------------------------------------------------------- demo cards
// These are the industry-standard *test* numbers. They are not real cards and
// they cannot be used to move money anywhere.
const DEMO_CARDS = {
  '4242424242424242': { brand: 'Visa (test)', outcome: 'approved' },
  '4000056655665556': { brand: 'Visa Debit (test)', outcome: 'approved' },
  '5555555555554444': { brand: 'Mastercard (test)', outcome: 'approved' },
  '4000000000000002': { brand: 'Visa (test)', outcome: 'declined' },
  '4000000000009995': { brand: 'Visa (test)', outcome: 'insufficient_funds' }
};
const PRIMARY_TEST_CARD = '4242 4242 4242 4242';

function checkoutState(req) {
  if (!req.session.checkout || typeof req.session.checkout !== 'object') {
    req.session.checkout = {};
  }
  return req.session.checkout;
}

function currentCart(req) {
  const { items, issues } = cart.getDetailedCart(req);
  return { items, issues };
}

function requireItems(req, res, next) {
  const { items, issues } = currentCart(req);
  issues.forEach((i) => req.flash('error', i.message));
  if (!items.length) {
    req.flash('error', 'Your basket is empty, so there is nothing to check out.');
    return res.redirect('/cart');
  }
  req.cartItems = items;
  return next();
}

function totalsFor(req, items) {
  const state = checkoutState(req);
  return priceCart(items, {
    promoCode: req.session.promo,
    shippingMethod: state.shippingMethod || req.session.shippingMethod || 'standard'
  });
}

function generateOrderNumber() {
  const d = new Date();
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  for (let attempt = 0; attempt < 12; attempt++) {
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    const number = `NW-${day}-${rand}`;
    const clash = db.prepare('SELECT 1 FROM orders WHERE order_number = ?').get(number);
    if (!clash) return number;
  }
  throw new Error('Could not generate a unique order number.');
}

function validateAddressBody(body, opts = {}) {
  const a = {
    email: String(body.email || '').trim().toLowerCase().slice(0, 160),
    ship_name: String(body.ship_name || '').trim().slice(0, 100),
    ship_line1: String(body.ship_line1 || '').trim().slice(0, 160),
    ship_line2: String(body.ship_line2 || '').trim().slice(0, 160) || null,
    ship_city: String(body.ship_city || '').trim().slice(0, 80),
    ship_region: String(body.ship_region || '').trim().slice(0, 80) || null,
    ship_postal: String(body.ship_postal || '').trim().slice(0, 20),
    ship_country: String(body.ship_country || 'US').trim().toUpperCase().slice(0, 2)
  };
  const errors = [];
  if (!opts.emailOptional && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(a.email)) {
    errors.push('A valid email address is required for the demo receipt.');
  }
  if (a.ship_name.length < 2) errors.push('Recipient name is required.');
  if (a.ship_line1.length < 3) errors.push('Address line 1 is required.');
  if (a.ship_city.length < 2) errors.push('City is required.');
  if (a.ship_postal.length < 3) errors.push('Postal / ZIP code is required.');
  if (!/^[A-Z]{2}$/.test(a.ship_country)) errors.push('Country must be a two-letter code (e.g. US, GB).');
  return { address: a, errors };
}

// ----------------------------------------------------------------- step 1
router.get('/', (req, res) => res.redirect('/checkout/address'));

router.get('/address', requireItems, (req, res) => {
  const state = checkoutState(req);
  const user = req.session.user;
  const saved = user
    ? db.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC').all(user.id)
    : [];

  let form = state.address || {};
  if (!state.address && saved.length) {
    const d = saved[0];
    form = {
      email: user.email,
      ship_name: d.full_name, ship_line1: d.line1, ship_line2: d.line2,
      ship_city: d.city, ship_region: d.region, ship_postal: d.postal_code,
      ship_country: d.country
    };
  }
  if (user && !form.email) form.email = user.email;

  res.render('checkout/address', {
    title: 'Checkout - delivery address (demo)',
    step: 1,
    form,
    savedAddresses: saved,
    errors: [],
    items: req.cartItems,
    totals: totalsFor(req, req.cartItems)
  });
});

router.post('/address', requireItems, (req, res) => {
  const user = req.session.user;

  // "Use a saved address" shortcut.
  if (req.body.use_address_id && user) {
    const a = db.prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ?')
      .get(Number.parseInt(req.body.use_address_id, 10), user.id);
    if (a) {
      checkoutState(req).address = {
        email: user.email,
        ship_name: a.full_name, ship_line1: a.line1, ship_line2: a.line2,
        ship_city: a.city, ship_region: a.region, ship_postal: a.postal_code,
        ship_country: a.country
      };
      return res.redirect('/checkout/shipping');
    }
  }

  const { address, errors } = validateAddressBody(req.body);
  if (errors.length) {
    return res.status(400).render('checkout/address', {
      title: 'Checkout - delivery address (demo)',
      step: 1,
      form: address,
      savedAddresses: user
        ? db.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC').all(user.id)
        : [],
      errors,
      items: req.cartItems,
      totals: totalsFor(req, req.cartItems)
    });
  }

  checkoutState(req).address = address;

  // Optionally keep it on the account for next time.
  if (user && req.body.save_address) {
    db.prepare(`
      INSERT INTO addresses (user_id, label, full_name, line1, line2, city, region, postal_code, country, is_default)
      VALUES (?, 'Checkout', ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(user.id, address.ship_name, address.ship_line1, address.ship_line2,
      address.ship_city, address.ship_region, address.ship_postal, address.ship_country);
  }

  res.redirect('/checkout/shipping');
});

// ----------------------------------------------------------------- step 2
router.get('/shipping', requireItems, (req, res) => {
  const state = checkoutState(req);
  if (!state.address) {
    req.flash('error', 'Please enter a delivery address first.');
    return res.redirect('/checkout/address');
  }
  res.render('checkout/shipping', {
    title: 'Checkout - delivery method (demo)',
    step: 2,
    methods: SHIPPING_METHODS,
    selected: state.shippingMethod || 'standard',
    items: req.cartItems,
    totals: totalsFor(req, req.cartItems),
    address: state.address
  });
});

router.post('/shipping', requireItems, (req, res) => {
  const state = checkoutState(req);
  if (!state.address) return res.redirect('/checkout/address');

  const code = String(req.body.shipping_method || '');
  if (!SHIPPING_METHODS[code]) {
    req.flash('error', 'Please choose one of the delivery options.');
    return res.redirect('/checkout/shipping');
  }
  state.shippingMethod = code;
  req.session.shippingMethod = code;
  res.redirect('/checkout/payment');
});

// ------------------------------------------------- step 3 (SIMULATED ONLY)
router.get('/payment', requireItems, (req, res) => {
  const state = checkoutState(req);
  if (!state.address) return res.redirect('/checkout/address');
  if (!state.shippingMethod) return res.redirect('/checkout/shipping');

  res.render('checkout/payment', {
    title: 'Checkout - demo payment (no real payment)',
    step: 3,
    items: req.cartItems,
    totals: totalsFor(req, req.cartItems),
    address: state.address,
    testCard: PRIMARY_TEST_CARD,
    form: {},
    errors: []
  });
});

router.post('/payment', requireItems, (req, res) => {
  const state = checkoutState(req);
  if (!state.address) return res.redirect('/checkout/address');
  if (!state.shippingMethod) return res.redirect('/checkout/shipping');

  const items = req.cartItems;
  const totals = totalsFor(req, items);

  const rawNumber = String(req.body.card_number || '').replace(/[\s-]/g, '');
  const name = String(req.body.card_name || '').trim().slice(0, 100);
  const expiry = String(req.body.card_expiry || '').trim();
  const cvc = String(req.body.card_cvc || '').trim();

  const errors = [];
  if (name.length < 2) errors.push('Name on card is required.');

  const m = expiry.match(/^(\d{2})\s*\/\s*(\d{2})$/);
  if (!m) {
    errors.push('Expiry must be in MM/YY format.');
  } else {
    const month = Number(m[1]);
    const year = 2000 + Number(m[2]);
    const now = new Date();
    const endOfMonth = new Date(year, month, 1);
    if (month < 1 || month > 12) errors.push('Expiry month must be between 01 and 12.');
    else if (endOfMonth <= now) errors.push('That expiry date is in the past - use any future date.');
  }

  if (!/^\d{3,4}$/.test(cvc)) errors.push('Security code must be 3 or 4 digits.');

  const demoCard = DEMO_CARDS[rawNumber];
  if (!demoCard) {
    errors.push(
      `This demo only accepts test card numbers. Use ${PRIMARY_TEST_CARD} for an approved demo payment. ` +
      'Never type a real card number into a demo like this one.'
    );
  } else if (demoCard.outcome !== 'approved') {
    errors.push(
      demoCard.outcome === 'declined'
        ? 'Simulated result: card declined. Try the approved test number instead.'
        : 'Simulated result: insufficient funds. Try the approved test number instead.'
    );
  }

  if (errors.length) {
    return res.status(400).render('checkout/payment', {
      title: 'Checkout - demo payment (no real payment)',
      step: 3,
      items,
      totals,
      address: state.address,
      testCard: PRIMARY_TEST_CARD,
      // Deliberately does not echo the card number back into the form.
      form: { card_name: name, card_expiry: expiry },
      errors
    });
  }

  const last4 = rawNumber.slice(-4);
  const user = req.session.user || null;
  const address = state.address;

  let orderNumber;
  try {
    const place = db.transaction(() => {
      // Re-check stock inside the transaction, then decrement it there too.
      const decrement = db.prepare(
        'UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?'
      );
      for (const line of items) {
        const info = decrement.run(line.quantity, line.product_id, line.quantity);
        if (info.changes !== 1) {
          const err = new Error(`"${line.name}" sold out while you were checking out.`);
          err.code = 'OUT_OF_STOCK';
          throw err;
        }
      }

      const number = generateOrderNumber();
      const orderId = db.prepare(`
        INSERT INTO orders (
          order_number, user_id, email, status,
          subtotal_cents, discount_cents, shipping_cents, tax_cents, total_cents,
          promo_code, shipping_method,
          ship_name, ship_line1, ship_line2, ship_city, ship_region, ship_postal, ship_country,
          payment_brand, payment_last4
        ) VALUES (
          @order_number, @user_id, @email, 'paid',
          @subtotal_cents, @discount_cents, @shipping_cents, @tax_cents, @total_cents,
          @promo_code, @shipping_method,
          @ship_name, @ship_line1, @ship_line2, @ship_city, @ship_region, @ship_postal, @ship_country,
          @payment_brand, @payment_last4
        )
      `).run({
        order_number: number,
        user_id: user ? user.id : null,
        email: address.email,
        subtotal_cents: totals.subtotal_cents,
        discount_cents: totals.discount_cents,
        shipping_cents: totals.shipping_cents,
        tax_cents: totals.tax_cents,
        total_cents: totals.total_cents,
        promo_code: totals.promo ? totals.promo.code : null,
        shipping_method: state.shippingMethod,
        ship_name: address.ship_name,
        ship_line1: address.ship_line1,
        ship_line2: address.ship_line2,
        ship_city: address.ship_city,
        ship_region: address.ship_region,
        ship_postal: address.ship_postal,
        ship_country: address.ship_country,
        payment_brand: `DEMO ${demoCard.brand}`,
        payment_last4: last4
      }).lastInsertRowid;

      const insertItem = db.prepare(`
        INSERT INTO order_items (order_id, product_id, name, slug, unit_price_cents, quantity, line_total_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const line of items) {
        insertItem.run(orderId, line.product_id, line.name, line.slug,
          line.unit_price_cents, line.quantity, line.line_total_cents);
      }
      return number;
    });

    orderNumber = place();
  } catch (err) {
    if (err && err.code === 'OUT_OF_STOCK') {
      req.flash('error', `${err.message} Nothing was charged - this is a demo anyway.`);
      return res.redirect('/cart');
    }
    throw err;
  }

  cart.clearCart(req);
  delete req.session.promo;
  delete req.session.checkout;
  req.session.orderNumbers = (req.session.orderNumbers || []).concat(orderNumber).slice(-20);

  res.redirect(`/checkout/confirmation/${orderNumber}`);
});

// ----------------------------------------------------------------- step 4
router.get('/confirmation/:number', (req, res, next) => {
  const number = String(req.params.number);
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(number);
  if (!order) return next();

  const user = req.session.user;
  const owns = user && order.user_id === user.id;
  const inSession = (req.session.orderNumbers || []).includes(number);
  if (!owns && !inSession) {
    res.status(403);
    return res.render('error', {
      title: 'Not your order',
      status: 403,
      message: 'That order belongs to another demo session. Sign in to view your own orders.'
    });
  }

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.id);
  const method = SHIPPING_METHODS[order.shipping_method] || SHIPPING_METHODS.standard;

  res.render('checkout/confirmation', {
    title: `Demo order ${order.order_number} confirmed`,
    step: 4,
    order,
    items,
    method
  });
});

module.exports = router;

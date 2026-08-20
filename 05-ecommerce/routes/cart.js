'use strict';
const express = require('express');
const cart = require('../middleware/cart');
const { priceCart, normalisePromo, SHIPPING_METHODS } = require('../middleware/pricing');

const router = express.Router();

function backTo(req, fallback = '/cart') {
  const ref = req.body.redirect_to;
  if (typeof ref === 'string' && ref.startsWith('/') && !ref.startsWith('//')) return ref;
  return fallback;
}

router.get('/', (req, res) => {
  const { items, issues } = cart.getDetailedCart(req);
  issues.forEach((i) => req.flash('error', i.message));

  const method = req.session.shippingMethod || 'standard';
  const totals = priceCart(items, { promoCode: req.session.promo, shippingMethod: method });

  res.render('cart', {
    title: 'Your basket - demo store',
    items,
    totals,
    promoCode: req.session.promo || '',
    shippingMethods: SHIPPING_METHODS,
    shippingMethod: method
  });
});

router.post('/add', (req, res) => {
  const result = cart.addItem(req, req.body.product_id, req.body.quantity);

  if (!result.ok) {
    const messages = {
      not_found: 'That product is not in the demo catalogue.',
      bad_quantity: 'Please choose a quantity of at least 1.',
      out_of_stock: 'Sorry, that item is out of stock.'
    };
    req.flash('error', messages[result.reason] || 'Could not add that item.');
    return res.redirect(backTo(req, '/products'));
  }

  if (result.clamped) {
    req.flash('error', `Only ${result.quantity} of "${result.product.name}" available - basket updated to that.`);
  } else {
    req.flash('success', `Added "${result.product.name}" to your basket.`);
  }
  return res.redirect(backTo(req, '/cart'));
});

router.post('/update', (req, res) => {
  const result = cart.updateItem(req, req.body.product_id, req.body.quantity);
  if (!result.ok) {
    req.flash('error', 'Could not update that line.');
  } else if (result.quantity === 0) {
    req.flash('success', 'Item removed from your basket.');
  } else if (result.clamped) {
    req.flash('error', `Only ${result.quantity} left in stock - quantity adjusted.`);
  } else {
    req.flash('success', 'Basket updated.');
  }
  res.redirect(backTo(req));
});

router.post('/remove', (req, res) => {
  cart.removeItem(req, req.body.product_id);
  req.flash('success', 'Item removed from your basket.');
  res.redirect(backTo(req));
});

router.post('/clear', (req, res) => {
  cart.clearCart(req);
  delete req.session.promo;
  req.flash('success', 'Basket emptied.');
  res.redirect('/cart');
});

router.post('/promo', (req, res) => {
  const raw = String(req.body.promo_code || '').trim();
  if (!raw) {
    delete req.session.promo;
    req.flash('success', 'Promo code removed.');
    return res.redirect('/cart');
  }
  const promo = normalisePromo(raw);
  if (!promo) {
    req.flash('error', `"${raw.slice(0, 24)}" is not a valid code. Try SAVE10 in this demo.`);
    return res.redirect('/cart');
  }
  req.session.promo = promo.code;
  req.flash('success', `Code ${promo.code} applied - ${promo.label}.`);
  res.redirect('/cart');
});

module.exports = router;

'use strict';
/**
 * All money is handled in integer cents. Prices are always re-read from the
 * database - a price or total posted by the browser is never trusted.
 */

const TAX_RATE = 0.08; // 8% demo sales tax
const FREE_SHIPPING_THRESHOLD_CENTS = 7500;

const SHIPPING_METHODS = {
  standard: {
    code: 'standard',
    label: 'Standard',
    eta: '3-5 working days',
    price_cents: 599,
    note: `Free on orders over $${(FREE_SHIPPING_THRESHOLD_CENTS / 100).toFixed(2)}`
  },
  express: {
    code: 'express',
    label: 'Express',
    eta: '1-2 working days',
    price_cents: 1299,
    note: 'Dispatched same day if ordered before 2pm'
  },
  pickup: {
    code: 'pickup',
    label: 'Collect in store',
    eta: 'Ready in 2 hours',
    price_cents: 0,
    note: 'Demo pickup point - Northwind Yard, Leeds'
  }
};

// The single promo code this demo understands.
const PROMO_CODES = {
  SAVE10: { code: 'SAVE10', kind: 'percent', value: 10, label: '10% off your subtotal' }
};

function normalisePromo(code) {
  if (!code) return null;
  const key = String(code).trim().toUpperCase();
  return PROMO_CODES[key] || null;
}

function shippingFor(methodCode, subtotalAfterDiscount) {
  const method = SHIPPING_METHODS[methodCode] || SHIPPING_METHODS.standard;
  if (method.code === 'standard' && subtotalAfterDiscount >= FREE_SHIPPING_THRESHOLD_CENTS) {
    return { method, price_cents: 0, freeShipping: true };
  }
  return { method, price_cents: method.price_cents, freeShipping: false };
}

/**
 * @param {Array<{unit_price_cents:number, quantity:number}>} items
 * @param {{promoCode?:string, shippingMethod?:string}} opts
 */
function priceCart(items, opts = {}) {
  const subtotal_cents = items.reduce(
    (sum, it) => sum + it.unit_price_cents * it.quantity,
    0
  );

  const promo = normalisePromo(opts.promoCode);
  let discount_cents = 0;
  if (promo && subtotal_cents > 0) {
    if (promo.kind === 'percent') {
      discount_cents = Math.round((subtotal_cents * promo.value) / 100);
    } else {
      discount_cents = Math.min(promo.value, subtotal_cents);
    }
  }

  const afterDiscount = Math.max(0, subtotal_cents - discount_cents);
  const ship = items.length
    ? shippingFor(opts.shippingMethod, afterDiscount)
    : { method: SHIPPING_METHODS[opts.shippingMethod] || SHIPPING_METHODS.standard, price_cents: 0, freeShipping: false };

  const tax_cents = Math.round(afterDiscount * TAX_RATE);
  const total_cents = afterDiscount + ship.price_cents + tax_cents;

  return {
    subtotal_cents,
    discount_cents,
    shipping_cents: ship.price_cents,
    tax_cents,
    total_cents,
    promo,
    freeShipping: ship.freeShipping,
    shippingMethod: ship.method,
    taxRate: TAX_RATE,
    freeShippingThreshold_cents: FREE_SHIPPING_THRESHOLD_CENTS,
    amountToFreeShipping_cents: Math.max(0, FREE_SHIPPING_THRESHOLD_CENTS - afterDiscount),
    itemCount: items.reduce((n, it) => n + it.quantity, 0)
  };
}

function formatMoney(cents) {
  const n = Number(cents || 0) / 100;
  return `$${n.toFixed(2)}`;
}

module.exports = {
  TAX_RATE,
  SHIPPING_METHODS,
  PROMO_CODES,
  FREE_SHIPPING_THRESHOLD_CENTS,
  normalisePromo,
  priceCart,
  formatMoney
};

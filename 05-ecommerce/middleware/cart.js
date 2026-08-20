'use strict';
/**
 * Cart storage.
 *   - Guests:        session-based ( req.session.cart = { [productId]: qty } )
 *   - Logged in:     DB-backed (carts / cart_items)
 *   - On login:      the session cart is merged into the user's DB cart.
 *
 * Quantities are validated server-side and clamped to available stock.
 * Prices always come from the products table, never from the request.
 */
const { db } = require('../db');

const MAX_QTY_PER_LINE = 20;

function parseQuantity(raw, fallback = 1) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function clampQuantity(qty, stock) {
  const limit = Math.min(MAX_QTY_PER_LINE, Math.max(0, Number(stock) || 0));
  return Math.max(0, Math.min(qty, limit));
}

function sessionCart(req) {
  if (!req.session.cart || typeof req.session.cart !== 'object') {
    req.session.cart = {};
  }
  return req.session.cart;
}

function userCartId(userId) {
  const row = db.prepare('SELECT id FROM carts WHERE user_id = ?').get(userId);
  if (row) return row.id;
  return db.prepare('INSERT INTO carts (user_id) VALUES (?)').run(userId).lastInsertRowid;
}

/** Raw lines: [{ product_id, quantity }] */
function rawLines(req) {
  const user = req.session.user;
  if (user) {
    const cartId = userCartId(user.id);
    return db
      .prepare('SELECT product_id, quantity FROM cart_items WHERE cart_id = ? ORDER BY id')
      .all(cartId);
  }
  return Object.entries(sessionCart(req)).map(([pid, qty]) => ({
    product_id: Number(pid),
    quantity: Number(qty)
  }));
}

function setLine(req, productId, quantity) {
  const user = req.session.user;
  if (user) {
    const cartId = userCartId(user.id);
    if (quantity <= 0) {
      db.prepare('DELETE FROM cart_items WHERE cart_id = ? AND product_id = ?').run(cartId, productId);
    } else {
      db.prepare(`
        INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (?, ?, ?)
        ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = excluded.quantity
      `).run(cartId, productId, quantity);
    }
    return;
  }
  const cart = sessionCart(req);
  if (quantity <= 0) delete cart[productId];
  else cart[productId] = quantity;
  req.session.cart = cart;
}

function getLineQuantity(req, productId) {
  const line = rawLines(req).find((l) => l.product_id === Number(productId));
  return line ? line.quantity : 0;
}

function getProduct(productId) {
  return db
    .prepare('SELECT id, name, slug, price_cents, stock, is_active FROM products WHERE id = ?')
    .get(Number(productId));
}

/**
 * Adds to the existing quantity. Returns { ok, quantity, clamped, product }.
 */
function addItem(req, productId, qtyRaw) {
  const product = getProduct(productId);
  if (!product || !product.is_active) return { ok: false, reason: 'not_found' };

  const requested = parseQuantity(qtyRaw, 1);
  if (requested <= 0) return { ok: false, reason: 'bad_quantity' };

  const current = getLineQuantity(req, product.id);
  const desired = current + requested;
  const finalQty = clampQuantity(desired, product.stock);

  if (finalQty <= 0) return { ok: false, reason: 'out_of_stock', product };
  setLine(req, product.id, finalQty);
  return { ok: true, quantity: finalQty, clamped: finalQty < desired, product };
}

/** Sets an absolute quantity. */
function updateItem(req, productId, qtyRaw) {
  const product = getProduct(productId);
  if (!product) return { ok: false, reason: 'not_found' };

  const requested = parseQuantity(qtyRaw, 0);
  if (requested < 0) return { ok: false, reason: 'bad_quantity' };

  const finalQty = clampQuantity(requested, product.stock);
  setLine(req, product.id, finalQty);
  return { ok: true, quantity: finalQty, clamped: finalQty < requested, product };
}

function removeItem(req, productId) {
  setLine(req, Number(productId), 0);
  return { ok: true };
}

function clearCart(req) {
  const user = req.session.user;
  if (user) {
    const cartId = userCartId(user.id);
    db.prepare('DELETE FROM cart_items WHERE cart_id = ?').run(cartId);
  }
  req.session.cart = {};
}

/**
 * Detailed cart with joined product rows and per-line issues
 * (product withdrawn, or stock now lower than the quantity in the cart).
 */
function getDetailedCart(req) {
  const lines = rawLines(req);
  const items = [];
  const issues = [];

  for (const line of lines) {
    const p = db.prepare(`
      SELECT p.id, p.name, p.slug, p.price_cents, p.stock, p.is_active,
             (SELECT url FROM product_images i WHERE i.product_id = p.id ORDER BY i.position LIMIT 1) AS image_url
      FROM products p WHERE p.id = ?
    `).get(line.product_id);

    if (!p || !p.is_active) {
      issues.push({ product_id: line.product_id, message: 'This item is no longer available and was removed.' });
      setLine(req, line.product_id, 0);
      continue;
    }

    let quantity = line.quantity;
    if (quantity > p.stock) {
      quantity = p.stock;
      issues.push({
        product_id: p.id,
        message: quantity > 0
          ? `Only ${p.stock} of "${p.name}" left - quantity reduced.`
          : `"${p.name}" sold out and was removed from your basket.`
      });
      setLine(req, p.id, quantity);
    }
    if (quantity <= 0) continue;

    items.push({
      product_id: p.id,
      name: p.name,
      slug: p.slug,
      image_url: p.image_url || '/img/placeholder.svg',
      stock: p.stock,
      unit_price_cents: p.price_cents,
      quantity,
      line_total_cents: p.price_cents * quantity,
      maxQuantity: Math.min(MAX_QTY_PER_LINE, p.stock)
    });
  }

  return { items, issues };
}

function cartCount(req) {
  try {
    return rawLines(req).reduce((n, l) => n + l.quantity, 0);
  } catch (e) {
    return 0;
  }
}

/** Called right after login: fold the guest cart into the user's DB cart. */
function mergeSessionCartIntoUser(req, userId) {
  const guest = req.session.cart && typeof req.session.cart === 'object' ? req.session.cart : {};
  const entries = Object.entries(guest);
  req.session.cart = {};
  if (!entries.length) return;

  const cartId = userCartId(userId);
  const merge = db.transaction(() => {
    for (const [pidRaw, qtyRaw] of entries) {
      const product = getProduct(pidRaw);
      if (!product || !product.is_active) continue;
      const existing = db
        .prepare('SELECT quantity FROM cart_items WHERE cart_id = ? AND product_id = ?')
        .get(cartId, product.id);
      const merged = clampQuantity((existing ? existing.quantity : 0) + parseQuantity(qtyRaw, 0), product.stock);
      if (merged <= 0) continue;
      db.prepare(`
        INSERT INTO cart_items (cart_id, product_id, quantity) VALUES (?, ?, ?)
        ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = excluded.quantity
      `).run(cartId, product.id, merged);
    }
  });
  merge();
}

module.exports = {
  MAX_QTY_PER_LINE,
  addItem,
  updateItem,
  removeItem,
  clearCart,
  getDetailedCart,
  cartCount,
  mergeSessionCartIntoUser,
  parseQuantity,
  clampQuantity
};

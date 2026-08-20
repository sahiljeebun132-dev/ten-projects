'use strict';
/** Admin area for the demo store. Requires an account with role = 'admin'. */
const express = require('express');
const { db } = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);

const STATUS_FLOW = {
  pending: ['paid', 'cancelled'],
  paid: ['packed', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: []
};

function slugify(s) {
  return String(s).toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function uniqueSlug(base, ignoreId = null) {
  let slug = base || 'product';
  let n = 1;
  for (;;) {
    const row = ignoreId
      ? db.prepare('SELECT id FROM products WHERE slug = ? AND id != ?').get(slug, ignoreId)
      : db.prepare('SELECT id FROM products WHERE slug = ?').get(slug);
    if (!row) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

function parsePriceToCents(raw) {
  const n = Number.parseFloat(String(raw ?? '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 1000000) return null;
  return Math.round(n * 100);
}

function validateProduct(body, ignoreId = null) {
  const name = String(body.name || '').trim().slice(0, 140);
  const description = String(body.description || '').trim().slice(0, 4000);
  const price_cents = parsePriceToCents(body.price);
  const stock = Number.parseInt(body.stock, 10);
  const category_id = Number.parseInt(body.category_id, 10);
  const is_active = body.is_active ? 1 : 0;

  const errors = [];
  if (name.length < 2) errors.push('Product name is required.');
  if (description.length < 10) errors.push('Please write a description of at least 10 characters.');
  if (price_cents === null) errors.push('Price must be a number like 24.99.');
  if (!Number.isInteger(stock) || stock < 0 || stock > 100000) errors.push('Stock must be a whole number of 0 or more.');
  if (!Number.isInteger(category_id) || !db.prepare('SELECT id FROM categories WHERE id = ?').get(category_id)) {
    errors.push('Please pick a valid category.');
  }

  const slugBase = slugify(body.slug || name);
  return {
    values: {
      name,
      description,
      price_cents: price_cents === null ? 0 : price_cents,
      stock: Number.isInteger(stock) ? stock : 0,
      category_id,
      is_active,
      slug: uniqueSlug(slugBase, ignoreId)
    },
    errors
  };
}

function categories() {
  return db.prepare('SELECT id, name, slug FROM categories ORDER BY name').all();
}

// --------------------------------------------------------------- dashboard
router.get('/', (req, res) => {
  const stats = {
    products: db.prepare('SELECT COUNT(*) n FROM products').get().n,
    active: db.prepare('SELECT COUNT(*) n FROM products WHERE is_active = 1').get().n,
    lowStock: db.prepare('SELECT COUNT(*) n FROM products WHERE stock <= 10').get().n,
    orders: db.prepare('SELECT COUNT(*) n FROM orders').get().n,
    revenue_cents: db.prepare("SELECT COALESCE(SUM(total_cents),0) n FROM orders WHERE status != 'cancelled'").get().n,
    customers: db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'customer'").get().n
  };
  const recentOrders = db.prepare(`
    SELECT id, order_number, email, status, total_cents, placed_at
    FROM orders ORDER BY placed_at DESC, id DESC LIMIT 8
  `).all();
  const lowStock = db.prepare(`
    SELECT id, name, slug, stock, price_cents FROM products
    WHERE is_active = 1 ORDER BY stock ASC LIMIT 8
  `).all();

  res.render('admin/dashboard', { title: 'Admin - demo store', stats, recentOrders, lowStock });
});

// ---------------------------------------------------------------- products
router.get('/products', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const rows = q
    ? db.prepare(`
        SELECT p.*, c.name AS category_name FROM products p JOIN categories c ON c.id = p.category_id
        WHERE p.name LIKE ? ORDER BY p.id DESC
      `).all(`%${q}%`)
    : db.prepare(`
        SELECT p.*, c.name AS category_name FROM products p JOIN categories c ON c.id = p.category_id
        ORDER BY p.id DESC
      `).all();

  res.render('admin/products', { title: 'Admin - products', products: rows, q });
});

router.get('/products/new', (req, res) => {
  res.render('admin/product-form', {
    title: 'Admin - new product',
    mode: 'new',
    product: { is_active: 1, stock: 0, price_cents: 0 },
    categories: categories(),
    errors: []
  });
});

router.post('/products', (req, res) => {
  const { values, errors } = validateProduct(req.body);
  if (errors.length) {
    return res.status(400).render('admin/product-form', {
      title: 'Admin - new product',
      mode: 'new',
      product: { ...values, price: req.body.price },
      categories: categories(),
      errors
    });
  }

  const create = db.transaction(() => {
    const id = db.prepare(`
      INSERT INTO products (name, slug, description, price_cents, stock, category_id, is_active)
      VALUES (@name, @slug, @description, @price_cents, @stock, @category_id, @is_active)
    `).run(values).lastInsertRowid;
    // Give new products the shared placeholder so galleries never break.
    db.prepare('INSERT INTO product_images (product_id, url, alt, position) VALUES (?, ?, ?, 0)')
      .run(id, '/img/placeholder.svg', values.name);
    return id;
  });
  const id = create();

  req.flash('success', `Created "${values.name}".`);
  res.redirect(`/admin/products/${id}/edit`);
});

router.get('/products/:id/edit', (req, res, next) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?')
    .get(Number.parseInt(req.params.id, 10));
  if (!product) return next();
  res.render('admin/product-form', {
    title: `Admin - edit ${product.name}`,
    mode: 'edit',
    product,
    categories: categories(),
    errors: []
  });
});

router.put('/products/:id', (req, res, next) => {
  const id = Number.parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!existing) return next();

  const { values, errors } = validateProduct(req.body, id);
  if (errors.length) {
    return res.status(400).render('admin/product-form', {
      title: `Admin - edit ${existing.name}`,
      mode: 'edit',
      product: { ...existing, ...values },
      categories: categories(),
      errors
    });
  }

  db.prepare(`
    UPDATE products SET name = @name, slug = @slug, description = @description,
      price_cents = @price_cents, stock = @stock, category_id = @category_id, is_active = @is_active
    WHERE id = @id
  `).run({ ...values, id });

  req.flash('success', `Saved "${values.name}".`);
  res.redirect('/admin/products');
});

// Quick stock-only edit from the product list.
router.post('/products/:id/stock', (req, res, next) => {
  const id = Number.parseInt(req.params.id, 10);
  const product = db.prepare('SELECT id, name FROM products WHERE id = ?').get(id);
  if (!product) return next();

  const stock = Number.parseInt(req.body.stock, 10);
  if (!Number.isInteger(stock) || stock < 0 || stock > 100000) {
    req.flash('error', 'Stock must be a whole number of 0 or more.');
  } else {
    db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(stock, id);
    req.flash('success', `Stock for "${product.name}" set to ${stock}.`);
  }
  res.redirect('/admin/products');
});

router.delete('/products/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const product = db.prepare('SELECT id, name FROM products WHERE id = ?').get(id);
  if (!product) {
    req.flash('error', 'Product not found.');
    return res.redirect('/admin/products');
  }
  const ordered = db.prepare('SELECT 1 FROM order_items WHERE product_id = ? LIMIT 1').get(id);
  if (ordered) {
    // Keep order history intact - withdraw from sale instead of deleting.
    db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run(id);
    req.flash('success', `"${product.name}" appears in past orders, so it was withdrawn from sale rather than deleted.`);
  } else {
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
    req.flash('success', `Deleted "${product.name}".`);
  }
  res.redirect('/admin/products');
});

// ------------------------------------------------------------------ orders
router.get('/orders', (req, res) => {
  const status = String(req.query.status || '').trim();
  const rows = STATUS_FLOW[status]
    ? db.prepare(`
        SELECT o.*, (SELECT SUM(quantity) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
        FROM orders o WHERE status = ? ORDER BY placed_at DESC, id DESC
      `).all(status)
    : db.prepare(`
        SELECT o.*, (SELECT SUM(quantity) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
        FROM orders o ORDER BY placed_at DESC, id DESC
      `).all();

  res.render('admin/orders', {
    title: 'Admin - orders',
    orders: rows,
    status: STATUS_FLOW[status] ? status : '',
    statuses: Object.keys(STATUS_FLOW)
  });
});

router.get('/orders/:id', (req, res, next) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?')
    .get(Number.parseInt(req.params.id, 10));
  if (!order) return next();
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.id);
  res.render('admin/order', {
    title: `Admin - order ${order.order_number}`,
    order,
    items,
    nextStatuses: STATUS_FLOW[order.status] || []
  });
});

router.post('/orders/:id/status', (req, res, next) => {
  const id = Number.parseInt(req.params.id, 10);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return next();

  const next_ = String(req.body.status || '');
  const allowed = STATUS_FLOW[order.status] || [];
  if (!allowed.includes(next_)) {
    req.flash('error', `Cannot move an order from "${order.status}" to "${next_}".`);
    return res.redirect(`/admin/orders/${id}`);
  }

  const apply = db.transaction(() => {
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(next_, id);
    if (next_ === 'cancelled') {
      // Put the stock back.
      const lines = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(id);
      const restock = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
      for (const l of lines) if (l.product_id) restock.run(l.quantity, l.product_id);
    }
  });
  apply();

  req.flash('success', `Order ${order.order_number} is now "${next_}".`);
  res.redirect(`/admin/orders/${id}`);
});

module.exports = router;

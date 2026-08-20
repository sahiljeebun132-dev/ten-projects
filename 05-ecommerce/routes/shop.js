'use strict';
const express = require('express');
const { db } = require('../db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();
const PER_PAGE = 9;

const SORTS = {
  newest: { label: 'Newest', sql: 'p.created_at DESC, p.id DESC' },
  price_asc: { label: 'Price: low to high', sql: 'p.price_cents ASC, p.id ASC' },
  price_desc: { label: 'Price: high to low', sql: 'p.price_cents DESC, p.id ASC' },
  rating: { label: 'Top rated', sql: 'p.rating DESC, p.rating_count DESC, p.id ASC' },
  name: { label: 'Name A-Z', sql: 'p.name ASC' }
};

const LIST_COLUMNS = `
  p.id, p.name, p.slug, p.price_cents, p.stock, p.rating, p.rating_count, p.created_at,
  c.name AS category_name, c.slug AS category_slug,
  (SELECT url FROM product_images i WHERE i.product_id = p.id ORDER BY i.position LIMIT 1) AS image_url
`;

function toCents(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number.parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** Builds a parameterised WHERE clause from the query string. */
function buildFilters(query) {
  const where = ['p.is_active = 1'];
  const params = [];

  const q = (query.q || '').toString().trim().slice(0, 80);
  if (q) {
    where.push('(p.name LIKE ? OR p.description LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }

  const category = (query.category || '').toString().trim().slice(0, 60);
  if (category) {
    where.push('c.slug = ?');
    params.push(category);
  }

  const min = toCents(query.min);
  if (min !== null) {
    where.push('p.price_cents >= ?');
    params.push(min);
  }
  const max = toCents(query.max);
  if (max !== null) {
    where.push('p.price_cents <= ?');
    params.push(max);
  }

  if (query.in_stock === '1') where.push('p.stock > 0');

  return { where: where.join(' AND '), params, q, category, min, max };
}

// ---------------------------------------------------------------- home
router.get('/', (req, res) => {
  const featured = db.prepare(`
    SELECT ${LIST_COLUMNS} FROM products p JOIN categories c ON c.id = p.category_id
    WHERE p.is_active = 1 ORDER BY p.rating DESC, p.rating_count DESC LIMIT 6
  `).all();

  const newest = db.prepare(`
    SELECT ${LIST_COLUMNS} FROM products p JOIN categories c ON c.id = p.category_id
    WHERE p.is_active = 1 ORDER BY p.created_at DESC, p.id DESC LIMIT 3
  `).all();

  const categories = db.prepare(`
    SELECT c.id, c.name, c.slug, c.description, COUNT(p.id) AS product_count
    FROM categories c LEFT JOIN products p ON p.category_id = c.id AND p.is_active = 1
    GROUP BY c.id ORDER BY c.name
  `).all();

  res.render('home', {
    title: 'Northwind Goods - demo store',
    featured,
    newest,
    categories
  });
});

// ------------------------------------------------------------- browse
router.get('/products', (req, res) => {
  const f = buildFilters(req.query);
  const sortKey = SORTS[req.query.sort] ? req.query.sort : 'newest';

  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM products p JOIN categories c ON c.id = p.category_id
    WHERE ${f.where}
  `).get(...f.params).n;

  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  let page = Number.parseInt(req.query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (page > pages) page = pages;
  const offset = (page - 1) * PER_PAGE;

  const products = db.prepare(`
    SELECT ${LIST_COLUMNS}
    FROM products p JOIN categories c ON c.id = p.category_id
    WHERE ${f.where}
    ORDER BY ${SORTS[sortKey].sql}
    LIMIT ? OFFSET ?
  `).all(...f.params, PER_PAGE, offset);

  const categories = db.prepare(`
    SELECT c.name, c.slug, COUNT(p.id) AS product_count
    FROM categories c LEFT JOIN products p ON p.category_id = c.id AND p.is_active = 1
    GROUP BY c.id ORDER BY c.name
  `).all();

  const priceRange = db.prepare(`
    SELECT MIN(price_cents) AS lo, MAX(price_cents) AS hi FROM products WHERE is_active = 1
  `).get();

  // Preserve filters when building pagination / sort links.
  const baseParams = new URLSearchParams();
  if (f.q) baseParams.set('q', f.q);
  if (f.category) baseParams.set('category', f.category);
  if (req.query.min) baseParams.set('min', String(req.query.min));
  if (req.query.max) baseParams.set('max', String(req.query.max));
  if (req.query.in_stock === '1') baseParams.set('in_stock', '1');

  const linkFor = (overrides) => {
    const p = new URLSearchParams(baseParams);
    p.set('sort', sortKey);
    Object.entries(overrides).forEach(([k, v]) => {
      if (v === null || v === undefined || v === '') p.delete(k);
      else p.set(k, String(v));
    });
    const s = p.toString();
    return `/products${s ? `?${s}` : ''}`;
  };

  res.render('products', {
    title: f.q ? `Search: ${f.q}` : 'All products - demo catalogue',
    products,
    categories,
    total,
    page,
    pages,
    perPage: PER_PAGE,
    sortKey,
    sorts: SORTS,
    filters: f,
    priceRange,
    linkFor
  });
});

// -------------------------------------------------------- product page
router.get('/products/:slug', (req, res, next) => {
  const product = db.prepare(`
    SELECT p.*, c.name AS category_name, c.slug AS category_slug
    FROM products p JOIN categories c ON c.id = p.category_id
    WHERE p.slug = ?
  `).get(String(req.params.slug));

  if (!product || !product.is_active) return next();

  const images = db
    .prepare('SELECT url, alt FROM product_images WHERE product_id = ? ORDER BY position')
    .all(product.id);

  const reviews = db.prepare(`
    SELECT r.id, r.rating, r.title, r.body, r.created_at, u.name AS author
    FROM reviews r JOIN users u ON u.id = r.user_id
    WHERE r.product_id = ? ORDER BY r.created_at DESC, r.id DESC
  `).all(product.id);

  const related = db.prepare(`
    SELECT ${LIST_COLUMNS}
    FROM products p JOIN categories c ON c.id = p.category_id
    WHERE p.category_id = ? AND p.id != ? AND p.is_active = 1
    ORDER BY p.rating DESC LIMIT 4
  `).all(product.category_id, product.id);

  const myReview = req.session.user
    ? db.prepare('SELECT id FROM reviews WHERE product_id = ? AND user_id = ?')
        .get(product.id, req.session.user.id)
    : null;

  res.render('product', {
    title: `${product.name} - Northwind Goods (demo)`,
    product,
    images: images.length ? images : [{ url: '/img/placeholder.svg', alt: product.name }],
    reviews,
    related,
    alreadyReviewed: !!myReview
  });
});

// ------------------------------------------------------------ reviews
router.post('/products/:slug/reviews', requireLogin, (req, res, next) => {
  const product = db.prepare('SELECT id, slug, rating, rating_count FROM products WHERE slug = ?')
    .get(String(req.params.slug));
  if (!product) return next();

  const rating = Number.parseInt(req.body.rating, 10);
  const title = String(req.body.title || '').trim().slice(0, 120);
  const body = String(req.body.body || '').trim().slice(0, 2000);

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    req.flash('error', 'Please choose a star rating between 1 and 5.');
    return res.redirect(`/products/${product.slug}#reviews`);
  }
  if (body.length < 4) {
    req.flash('error', 'Please write a few words in your review.');
    return res.redirect(`/products/${product.slug}#reviews`);
  }

  const existing = db.prepare('SELECT id FROM reviews WHERE product_id = ? AND user_id = ?')
    .get(product.id, req.session.user.id);
  if (existing) {
    req.flash('error', 'You have already reviewed this item.');
    return res.redirect(`/products/${product.slug}#reviews`);
  }

  const save = db.transaction(() => {
    db.prepare('INSERT INTO reviews (product_id, user_id, rating, title, body) VALUES (?, ?, ?, ?, ?)')
      .run(product.id, req.session.user.id, rating, title || 'Review', body);
    const count = product.rating_count + 1;
    const avg = (product.rating * product.rating_count + rating) / count;
    db.prepare('UPDATE products SET rating = ?, rating_count = ? WHERE id = ?')
      .run(Math.round(avg * 100) / 100, count, product.id);
  });
  save();

  req.flash('success', 'Thanks - your review has been added.');
  res.redirect(`/products/${product.slug}#reviews`);
});

module.exports = router;

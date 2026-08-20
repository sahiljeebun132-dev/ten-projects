-- Northwind Goods (DEMO STORE) - SQLite schema
-- This is a learning/demo project. No real payments, no real customer data.

PRAGMA foreign_keys = ON;

DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS cart_items;
DROP TABLE IF EXISTS carts;
DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS product_images;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS addresses;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer','admin')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE addresses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT NOT NULL DEFAULT 'Home',
  full_name   TEXT NOT NULL,
  line1       TEXT NOT NULL,
  line2       TEXT,
  city        TEXT NOT NULL,
  region      TEXT,
  postal_code TEXT NOT NULL,
  country     TEXT NOT NULL DEFAULT 'US',
  phone       TEXT,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_addresses_user ON addresses(user_id);

CREATE TABLE categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE products (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  description  TEXT NOT NULL,
  price_cents  INTEGER NOT NULL CHECK (price_cents >= 0),
  stock        INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  category_id  INTEGER NOT NULL REFERENCES categories(id),
  rating       REAL NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_price ON products(price_cents);

CREATE TABLE product_images (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  alt        TEXT NOT NULL DEFAULT '',
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_product_images_product ON product_images(product_id);

CREATE TABLE reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (product_id, user_id)
);
CREATE INDEX idx_reviews_product ON reviews(product_id);

-- DB-backed cart for logged-in users (guests use the session cart)
CREATE TABLE carts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE cart_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_id    INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  UNIQUE (cart_id, product_id)
);
CREATE INDEX idx_cart_items_cart ON cart_items(cart_id);

CREATE TABLE orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number    TEXT NOT NULL UNIQUE,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'paid'
                    CHECK (status IN ('pending','paid','packed','shipped','delivered','cancelled')),
  subtotal_cents  INTEGER NOT NULL,
  discount_cents  INTEGER NOT NULL DEFAULT 0,
  shipping_cents  INTEGER NOT NULL DEFAULT 0,
  tax_cents       INTEGER NOT NULL DEFAULT 0,
  total_cents     INTEGER NOT NULL,
  promo_code      TEXT,
  shipping_method TEXT NOT NULL DEFAULT 'standard',
  ship_name       TEXT NOT NULL,
  ship_line1      TEXT NOT NULL,
  ship_line2      TEXT,
  ship_city       TEXT NOT NULL,
  ship_region     TEXT,
  ship_postal     TEXT NOT NULL,
  ship_country    TEXT NOT NULL DEFAULT 'US',
  -- Simulated payment only. We store nothing but a masked demo value.
  payment_brand   TEXT NOT NULL DEFAULT 'DEMO',
  payment_last4   TEXT NOT NULL DEFAULT '4242',
  placed_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_orders_user ON orders(user_id);

CREATE TABLE order_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  slug             TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  line_total_cents INTEGER NOT NULL
);
CREATE INDEX idx_order_items_order ON order_items(order_id);

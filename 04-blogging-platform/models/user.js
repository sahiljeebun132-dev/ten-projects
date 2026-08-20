'use strict';

const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { slugify } = require('../lib/content');

const SALT_ROUNDS = 10;

/** Create a user with a bcrypt-hashed password. Returns the new row. */
function create({ name, email, password, role = 'author', bio = '' }) {
  const hash = bcrypt.hashSync(password, SALT_ROUNDS);
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash, role, bio) VALUES (?, ?, ?, ?, ?)')
    .run(name, String(email).toLowerCase().trim(), hash, role, bio);
  return findById(info.lastInsertRowid);
}

function findById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function findByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase().trim());
}

/** Find an author by the slugified form of their name (author archive URLs). */
function findBySlug(slug) {
  const wanted = String(slug || '').toLowerCase();
  return db.prepare('SELECT * FROM users ORDER BY id').all().find((u) => slugify(u.name) === wanted);
}

function all() {
  return db.prepare('SELECT id, name, email, role, bio, created_at FROM users ORDER BY id').all();
}

function count() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

/** Verify a plaintext password against a stored hash. */
function verifyPassword(user, password) {
  if (!user || !user.password_hash) return false;
  return bcrypt.compareSync(String(password || ''), user.password_hash);
}

/** Public shape stored in the session — never the password hash. */
function toSession(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

module.exports = { create, findById, findByEmail, findBySlug, all, count, verifyPassword, toSession, slugify };

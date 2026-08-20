'use strict';

const { db } = require('../db');

const MAX_NAME = 60;
const MAX_BODY = 2000;

/** Insert a comment. Caller must have validated that the post is published. */
function create({ post_id, author_name, body }) {
  const name = String(author_name || '').trim().slice(0, MAX_NAME);
  const text = String(body || '').trim().slice(0, MAX_BODY);
  const info = db
    .prepare('INSERT INTO comments (post_id, author_name, body) VALUES (?, ?, ?)')
    .run(post_id, name, text);
  return findById(info.lastInsertRowid);
}

function findById(id) {
  return db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
}

function listForPost(postId) {
  return db
    .prepare('SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC, id ASC')
    .all(postId);
}

function remove(id) {
  return db.prepare('DELETE FROM comments WHERE id = ?').run(id).changes > 0;
}

/** Recent comments across the whole site (admin dashboard). */
function recent(limit = 20) {
  return db
    .prepare(
      `SELECT c.*, p.title AS post_title, p.slug AS post_slug, p.author_id
         FROM comments c
         JOIN posts p ON p.id = c.post_id
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ?`
    )
    .all(limit);
}

function count() {
  return db.prepare('SELECT COUNT(*) AS n FROM comments').get().n;
}

module.exports = { create, findById, listForPost, remove, recent, count, MAX_NAME, MAX_BODY };

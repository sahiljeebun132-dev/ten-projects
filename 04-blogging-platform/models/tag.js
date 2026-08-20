'use strict';

const { db } = require('../db');
const { slugify } = require('../lib/content');

/** Find an existing tag by name/slug or insert it. Returns the tag row. */
function findOrCreate(name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return null;
  const slug = slugify(clean);
  if (!slug) return null;

  const existing = db.prepare('SELECT * FROM tags WHERE slug = ?').get(slug);
  if (existing) return existing;

  const info = db.prepare('INSERT INTO tags (name, slug) VALUES (?, ?)').run(clean, slug);
  return db.prepare('SELECT * FROM tags WHERE id = ?').get(info.lastInsertRowid);
}

function findBySlug(slug) {
  return db.prepare('SELECT * FROM tags WHERE slug = ?').get(String(slug || '').toLowerCase());
}

/** Parse a comma separated tag string into unique tag rows. */
function parseAndUpsert(input) {
  const names = String(input || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);

  const seen = new Set();
  const tags = [];
  for (const name of names) {
    const tag = findOrCreate(name);
    if (tag && !seen.has(tag.id)) {
      seen.add(tag.id);
      tags.push(tag);
    }
  }
  return tags;
}

/** All tags that have at least one published post, with post counts. */
function withPublishedCounts(limit = 50) {
  return db
    .prepare(
      `SELECT t.id, t.name, t.slug, COUNT(p.id) AS post_count
         FROM tags t
         JOIN post_tags pt ON pt.tag_id = t.id
         JOIN posts p      ON p.id = pt.post_id AND p.status = 'published'
        GROUP BY t.id
        ORDER BY post_count DESC, t.name ASC
        LIMIT ?`
    )
    .all(limit);
}

/** Delete tags that are no longer attached to any post. */
function pruneOrphans() {
  db.prepare('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM post_tags)').run();
}

module.exports = { findOrCreate, findBySlug, parseAndUpsert, withPublishedCounts, pruneOrphans };

'use strict';

const { db } = require('../db');
const { renderMarkdown, buildExcerpt, readingTime, slugify } = require('../lib/content');

const BASE_SELECT = `
  SELECT p.*,
         u.name AS author_name,
         (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
    FROM posts p
    JOIN users u ON u.id = p.author_id`;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Attach the tag rows to a post (or an array of posts). */
function withTags(post) {
  if (!post) return post;
  if (Array.isArray(post)) return post.map(withTags);
  post.tags = db
    .prepare(
      `SELECT t.id, t.name, t.slug
         FROM tags t
         JOIN post_tags pt ON pt.tag_id = t.id
        WHERE pt.post_id = ?
        ORDER BY t.name`
    )
    .all(post.id);
  return post;
}

/** Generate a slug that is unique across posts, ignoring `excludeId`. */
function uniqueSlug(source, excludeId = null) {
  const base = slugify(source);
  let candidate = base;
  let n = 2;
  const stmt = db.prepare('SELECT id FROM posts WHERE slug = ? AND id IS NOT ?');
  while (stmt.get(candidate, excludeId)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

function setTags(postId, tagIds) {
  db.prepare('DELETE FROM post_tags WHERE post_id = ?').run(postId);
  const insert = db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag_id) VALUES (?, ?)');
  for (const tagId of tagIds) insert.run(postId, tagId);
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

const create = db.transaction((data) => {
  const title = String(data.title || '').trim().slice(0, 200);
  const bodyMd = String(data.body_md || '');
  const status = data.status === 'published' ? 'published' : 'draft';
  const slug = uniqueSlug(data.slug || title, null);
  const excerpt = String(data.excerpt || '').trim() || buildExcerpt(bodyMd);

  const info = db
    .prepare(
      `INSERT INTO posts (author_id, title, slug, excerpt, body_md, body_html, cover_image,
                          status, reading_time, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.author_id,
      title,
      slug,
      excerpt,
      bodyMd,
      renderMarkdown(bodyMd),
      data.cover_image || null,
      status,
      readingTime(bodyMd),
      status === 'published' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null
    );

  setTags(info.lastInsertRowid, data.tagIds || []);
  return findById(info.lastInsertRowid);
});

const update = db.transaction((id, data) => {
  const current = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!current) return null;

  const title = String(data.title || '').trim().slice(0, 200) || current.title;
  const bodyMd = data.body_md === undefined ? current.body_md : String(data.body_md);
  const status = data.status === 'published' ? 'published' : 'draft';
  const slug = data.slug && data.slug !== current.slug ? uniqueSlug(data.slug, id) : current.slug;
  const excerpt = String(data.excerpt || '').trim() || buildExcerpt(bodyMd);
  const coverImage = data.cover_image === undefined ? current.cover_image : data.cover_image;

  let publishedAt = current.published_at;
  if (status === 'published' && !publishedAt) {
    publishedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  } else if (status === 'draft') {
    publishedAt = null;
  }

  db.prepare(
    `UPDATE posts
        SET title = ?, slug = ?, excerpt = ?, body_md = ?, body_html = ?, cover_image = ?,
            status = ?, reading_time = ?, published_at = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(
    title,
    slug,
    excerpt,
    bodyMd,
    renderMarkdown(bodyMd),
    coverImage,
    status,
    readingTime(bodyMd),
    publishedAt,
    id
  );

  if (data.tagIds) setTags(id, data.tagIds);
  return findById(id);
});

function remove(id) {
  return db.prepare('DELETE FROM posts WHERE id = ?').run(id).changes > 0;
}

/** Flip draft <-> published, keeping the first publication timestamp sane. */
function toggleStatus(id) {
  const post = db.prepare('SELECT id, status, published_at FROM posts WHERE id = ?').get(id);
  if (!post) return null;
  const next = post.status === 'published' ? 'draft' : 'published';
  const publishedAt =
    next === 'published'
      ? post.published_at || new Date().toISOString().slice(0, 19).replace('T', ' ')
      : null;
  db.prepare("UPDATE posts SET status = ?, published_at = ?, updated_at = datetime('now') WHERE id = ?")
    .run(next, publishedAt, id);
  return next;
}

function incrementViews(id) {
  db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').run(id);
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

function findById(id) {
  return withTags(db.prepare(`${BASE_SELECT} WHERE p.id = ?`).get(id));
}

function findBySlug(slug, { publishedOnly = false } = {}) {
  const sql = publishedOnly
    ? `${BASE_SELECT} WHERE p.slug = ? AND p.status = 'published'`
    : `${BASE_SELECT} WHERE p.slug = ?`;
  return withTags(db.prepare(sql).get(String(slug || '')));
}

/**
 * Paginated list of published posts, optionally filtered by tag or author.
 * Returns { posts, page, pages, total, perPage }.
 */
function listPublished({ page = 1, perPage = 5, tagId = null, authorId = null } = {}) {
  const where = ["p.status = 'published'"];
  const params = [];

  if (tagId) {
    where.push('p.id IN (SELECT post_id FROM post_tags WHERE tag_id = ?)');
    params.push(tagId);
  }
  if (authorId) {
    where.push('p.author_id = ?');
    params.push(authorId);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM posts p ${whereSql}`)
    .get(...params).n;

  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);

  const posts = db
    .prepare(
      `${BASE_SELECT} ${whereSql}
        ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...params, perPage, (current - 1) * perPage);

  return { posts: withTags(posts), page: current, pages, total, perPage };
}

/** Newest published posts (RSS). */
function latestPublished(limit = 20) {
  return withTags(
    db
      .prepare(
        `${BASE_SELECT} WHERE p.status = 'published'
          ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.id DESC LIMIT ?`
      )
      .all(limit)
  );
}

/** Turn a user query into a safe FTS5 MATCH expression (all terms required). */
function toMatchExpression(q) {
  const terms = String(q || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' AND ');
}

/**
 * Full-text search across title + body of published posts.
 * Uses the FTS5 index; falls back to LIKE if the index rejects the query.
 */
function search(q, { page = 1, perPage = 5 } = {}) {
  const query = String(q || '').trim();
  if (!query) return { posts: [], page: 1, pages: 1, total: 0, perPage, query };

  const match = toMatchExpression(query);
  if (match) {
    try {
      const total = db
        .prepare(
          `SELECT COUNT(*) AS n FROM posts p
             JOIN posts_fts f ON f.rowid = p.id
            WHERE posts_fts MATCH ? AND p.status = 'published'`
        )
        .get(match).n;

      const pages = Math.max(1, Math.ceil(total / perPage));
      const current = Math.min(Math.max(1, Number(page) || 1), pages);

      const posts = db
        .prepare(
          `${BASE_SELECT}
             JOIN posts_fts f ON f.rowid = p.id
            WHERE posts_fts MATCH ? AND p.status = 'published'
            ORDER BY rank
            LIMIT ? OFFSET ?`
        )
        .all(match, perPage, (current - 1) * perPage);

      return { posts: withTags(posts), page: current, pages, total, perPage, query };
    } catch (err) {
      // fall through to LIKE
    }
  }
  return likeSearch(query, { page, perPage });
}

function likeSearch(query, { page = 1, perPage = 5 } = {}) {
  const like = `%${query.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const where = `WHERE p.status = 'published'
                   AND (p.title LIKE ? ESCAPE '\\' OR p.body_md LIKE ? ESCAPE '\\')`;

  const total = db.prepare(`SELECT COUNT(*) AS n FROM posts p ${where}`).get(like, like).n;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);

  const posts = db
    .prepare(
      `${BASE_SELECT} ${where}
        ORDER BY COALESCE(p.published_at, p.created_at) DESC LIMIT ? OFFSET ?`
    )
    .all(like, like, perPage, (current - 1) * perPage);

  return { posts: withTags(posts), page: current, pages, total, perPage, query };
}

/** Dashboard listing: every post for an admin, own posts for an author. */
function listForDashboard({ authorId = null } = {}) {
  const sql = authorId
    ? `${BASE_SELECT} WHERE p.author_id = ? ORDER BY p.updated_at DESC, p.id DESC`
    : `${BASE_SELECT} ORDER BY p.updated_at DESC, p.id DESC`;
  const rows = authorId ? db.prepare(sql).all(authorId) : db.prepare(sql).all();
  return withTags(rows);
}

function stats({ authorId = null } = {}) {
  const scope = authorId ? 'WHERE author_id = ?' : '';
  const args = authorId ? [authorId] : [];
  return db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status = 'published'), 0) AS published,
              COALESCE(SUM(status = 'draft'), 0)     AS drafts,
              COALESCE(SUM(views), 0)                AS views
         FROM posts ${scope}`
    )
    .get(...args);
}

module.exports = {
  create,
  update,
  remove,
  toggleStatus,
  incrementViews,
  findById,
  findBySlug,
  listPublished,
  latestPublished,
  search,
  listForDashboard,
  stats,
  uniqueSlug,
  withTags
};

-- ---------------------------------------------------------------------------
-- Blogging platform schema
-- Applied automatically on boot when the tables are missing (see db/index.js).
-- Every statement is idempotent so the file can be re-applied safely.
-- ---------------------------------------------------------------------------

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Users -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'author' CHECK (role IN ('admin', 'author')),
  bio           TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- Posts -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title         TEXT    NOT NULL,
  slug          TEXT    NOT NULL UNIQUE,
  excerpt       TEXT    NOT NULL DEFAULT '',
  body_md       TEXT    NOT NULL DEFAULT '',
  body_html     TEXT    NOT NULL DEFAULT '',
  cover_image   TEXT,
  status        TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  views         INTEGER NOT NULL DEFAULT 0,
  reading_time  INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  published_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_posts_status_published ON posts (status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts (author_id);
CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts (slug);

-- Tags (many-to-many with posts) ----------------------------------------
CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS post_tags (
  post_id INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags  (id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags (tag_id);

-- Comments ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  author_name TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_id, created_at DESC);

-- Full-text search index over post title + body --------------------------
-- External-content FTS5 table kept in sync with `posts` through triggers.
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5 (
  title,
  body,
  content   = 'posts',
  content_rowid = 'id',
  tokenize  = 'porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts (rowid, title, body) VALUES (new.id, new.title, new.body_md);
END;

CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts (posts_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body_md);
END;

CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
  INSERT INTO posts_fts (posts_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body_md);
  INSERT INTO posts_fts (rowid, title, body) VALUES (new.id, new.title, new.body_md);
END;

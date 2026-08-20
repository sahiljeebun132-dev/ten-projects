-- Real-time chat application schema (SQLite)
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Registered and guest users. `password_hash` is NULL for guests.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nickname      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  is_guest      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

-- Chat rooms. Names are stored WITHOUT the leading '#'.
CREATE TABLE IF NOT EXISTS rooms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  topic       TEXT    NOT NULL DEFAULT '',
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);

-- Room membership (which rooms a user has joined / sees in their sidebar).
CREATE TABLE IF NOT EXISTS memberships (
  user_id   INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  room_id   INTEGER NOT NULL REFERENCES rooms(id)  ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  last_read_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, room_id)
);

-- Messages. Exactly one of room_id / dm_key is set:
--   room_id  -> a room message
--   dm_key   -> a direct message, key is 'dm:<lowerNickA>|<lowerNickB>' sorted
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id     INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
  dm_key      TEXT,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  nickname    TEXT    NOT NULL,
  body        TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'chat',  -- chat | me | system
  reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  edited_at   INTEGER,
  deleted_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_dm   ON messages(dm_key,  id DESC);

-- Emoji reactions; one row per (message, user, emoji).
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  nickname   TEXT    NOT NULL,
  emoji      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);

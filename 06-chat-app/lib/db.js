'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { dmKey, clampLimit, LIMITS } = require('./sanitise');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'db', 'chat.sqlite');

const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');

let db;

/** Open (and migrate) the database. Idempotent. */
function open() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

function handle() {
  return db || open();
}

const now = () => Date.now();

/* ------------------------------------------------------------------ users */

function findUserByNickname(nickname) {
  return handle()
    .prepare('SELECT * FROM users WHERE nickname = ? COLLATE NOCASE')
    .get(nickname);
}

function getUserById(id) {
  return handle().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/**
 * Sign in or register.
 * - No password + new nickname  -> guest account.
 * - Password + new nickname     -> registered account (bcrypt hash).
 * - Existing registered account -> password required and verified.
 * - Existing guest account      -> only reclaimable while nobody is online with it;
 *   the caller (sockets.js) decides that, we just report is_guest.
 * Returns { ok, user } or { ok:false, error, code }.
 */
function authenticate(nickname, password) {
  const existing = findUserByNickname(nickname);
  const hasPassword = typeof password === 'string' && password.length > 0;

  if (!existing) {
    if (hasPassword && (password.length < LIMITS.PASSWORD_MIN || password.length > LIMITS.PASSWORD_MAX)) {
      return { ok: false, code: 'BAD_PASSWORD', error: `Password must be ${LIMITS.PASSWORD_MIN}-${LIMITS.PASSWORD_MAX} characters.` };
    }
    const hash = hasPassword ? bcrypt.hashSync(password, 10) : null;
    const info = handle()
      .prepare('INSERT INTO users (nickname, password_hash, is_guest, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
      .run(nickname, hash, hasPassword ? 0 : 1, now(), now());
    return { ok: true, user: getUserById(info.lastInsertRowid), created: true };
  }

  if (existing.password_hash) {
    if (!hasPassword) {
      return { ok: false, code: 'PASSWORD_REQUIRED', error: 'That nickname is registered. Enter its password.' };
    }
    if (!bcrypt.compareSync(password, existing.password_hash)) {
      return { ok: false, code: 'BAD_CREDENTIALS', error: 'Incorrect password.' };
    }
    return { ok: true, user: existing };
  }

  // Existing guest nickname.
  if (hasPassword) {
    return { ok: false, code: 'GUEST_NICK', error: 'That nickname is in use as a guest name. Pick another one.' };
  }
  return { ok: true, user: existing, guestReclaim: true };
}

function touchLastSeen(userId, ts = now()) {
  handle().prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(ts, userId);
}

function getLastSeen(nicknames) {
  if (!nicknames.length) return {};
  const marks = nicknames.map(() => '?').join(',');
  const rows = handle()
    .prepare(`SELECT nickname, last_seen_at FROM users WHERE nickname IN (${marks}) COLLATE NOCASE`)
    .all(...nicknames);
  const out = {};
  for (const r of rows) out[r.nickname] = r.last_seen_at;
  return out;
}

/* ------------------------------------------------------------------ rooms */

function listRooms() {
  return handle()
    .prepare('SELECT id, name, topic, is_default, created_at FROM rooms ORDER BY is_default DESC, name ASC')
    .all();
}

function getRoomByName(name) {
  return handle().prepare('SELECT * FROM rooms WHERE name = ? COLLATE NOCASE').get(name);
}

function getRoomById(id) {
  return handle().prepare('SELECT * FROM rooms WHERE id = ?').get(id);
}

function createRoom(name, { topic = '', createdBy = null, isDefault = 0 } = {}) {
  const existing = getRoomByName(name);
  if (existing) return { ok: false, code: 'EXISTS', error: 'That room already exists.', room: existing };
  const info = handle()
    .prepare('INSERT INTO rooms (name, topic, is_default, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, String(topic).slice(0, LIMITS.TOPIC_MAX), isDefault ? 1 : 0, createdBy, now());
  return { ok: true, room: getRoomById(info.lastInsertRowid) };
}

function joinRoom(userId, roomId) {
  handle()
    .prepare('INSERT OR IGNORE INTO memberships (user_id, room_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)')
    .run(userId, roomId, now(), 0);
}

function leaveRoom(userId, roomId) {
  handle().prepare('DELETE FROM memberships WHERE user_id = ? AND room_id = ?').run(userId, roomId);
}

function listMemberships(userId) {
  return handle()
    .prepare(`SELECT r.id, r.name, r.topic, r.is_default, m.last_read_at
              FROM memberships m JOIN rooms r ON r.id = m.room_id
              WHERE m.user_id = ?
              ORDER BY r.is_default DESC, r.name ASC`)
    .all(userId);
}

function markRead(userId, roomId, ts = now()) {
  handle()
    .prepare('UPDATE memberships SET last_read_at = ? WHERE user_id = ? AND room_id = ?')
    .run(ts, userId, roomId);
}

/** Join every default room (used at sign-in). */
function joinDefaultRooms(userId) {
  const defaults = handle().prepare('SELECT id FROM rooms WHERE is_default = 1').all();
  for (const r of defaults) joinRoom(userId, r.id);
}

/* --------------------------------------------------------------- messages */

const REACTION_SQL = `
  SELECT emoji, nickname FROM reactions WHERE message_id = ? ORDER BY created_at ASC
`;

/** Collapse reaction rows into { '👍': ['ann','bob'] }. */
function reactionsFor(messageId) {
  const rows = handle().prepare(REACTION_SQL).all(messageId);
  const out = {};
  for (const r of rows) {
    (out[r.emoji] = out[r.emoji] || []).push(r.nickname);
  }
  return out;
}

function shapeMessage(row) {
  if (!row) return null;
  const msg = {
    id: row.id,
    roomId: row.room_id,
    room: row.room_name || null,
    dmKey: row.dm_key || null,
    userId: row.user_id,
    nickname: row.nickname,
    body: row.deleted_at ? '' : row.body,
    kind: row.kind,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deleted: !!row.deleted_at,
    replyTo: null,
    reactions: reactionsFor(row.id)
  };
  if (row.reply_to_id) {
    const parent = handle()
      .prepare('SELECT id, nickname, body, deleted_at FROM messages WHERE id = ?')
      .get(row.reply_to_id);
    if (parent) {
      msg.replyTo = {
        id: parent.id,
        nickname: parent.nickname,
        body: parent.deleted_at ? '' : String(parent.body).slice(0, 160),
        deleted: !!parent.deleted_at
      };
    }
  }
  return msg;
}

function insertMessage({ roomId = null, dmKeyValue = null, userId, nickname, body, kind = 'chat', replyToId = null }) {
  const info = handle()
    .prepare(`INSERT INTO messages (room_id, dm_key, user_id, nickname, body, kind, reply_to_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(roomId, dmKeyValue, userId, nickname, body, kind, replyToId, now());
  return getMessage(info.lastInsertRowid);
}

function getMessage(id) {
  const row = handle()
    .prepare(`SELECT m.*, r.name AS room_name FROM messages m
              LEFT JOIN rooms r ON r.id = m.room_id WHERE m.id = ?`)
    .get(id);
  return shapeMessage(row);
}

/**
 * Paginated history, newest-last. `before` is an exclusive message id cursor
 * (pass the oldest id you already have to page backwards).
 */
function getRoomHistory(roomId, { before = null, limit } = {}) {
  const take = clampLimit(limit);
  const params = [roomId];
  let sql = `SELECT m.*, r.name AS room_name FROM messages m
             LEFT JOIN rooms r ON r.id = m.room_id
             WHERE m.room_id = ?`;
  if (before) {
    sql += ' AND m.id < ?';
    params.push(before);
  }
  sql += ' ORDER BY m.id DESC LIMIT ?';
  params.push(take + 1);
  const rows = handle().prepare(sql).all(...params);
  const hasMore = rows.length > take;
  return {
    messages: rows.slice(0, take).reverse().map(shapeMessage),
    hasMore
  };
}

function getDmHistory(key, { before = null, limit } = {}) {
  const take = clampLimit(limit);
  const params = [key];
  let sql = 'SELECT * FROM messages WHERE dm_key = ?';
  if (before) {
    sql += ' AND id < ?';
    params.push(before);
  }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(take + 1);
  const rows = handle().prepare(sql).all(...params);
  const hasMore = rows.length > take;
  return {
    messages: rows.slice(0, take).reverse().map(shapeMessage),
    hasMore
  };
}

function countUnread(roomId, since) {
  const row = handle()
    .prepare(`SELECT COUNT(*) AS n FROM messages
              WHERE room_id = ? AND created_at > ? AND kind != 'system' AND deleted_at IS NULL`)
    .get(roomId, since || 0);
  return row ? row.n : 0;
}

function memberCounts() {
  return handle()
    .prepare('SELECT room_id, COUNT(*) AS n FROM memberships GROUP BY room_id')
    .all()
    .reduce((acc, r) => { acc[r.room_id] = r.n; return acc; }, {});
}

function editMessage(messageId, userId, body) {
  const row = handle().prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!row) return { ok: false, error: 'Message not found.' };
  if (row.deleted_at) return { ok: false, error: 'Message was deleted.' };
  if (row.user_id !== userId) return { ok: false, error: 'You can only edit your own messages.' };
  if (row.kind === 'system') return { ok: false, error: 'System messages cannot be edited.' };
  handle().prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(body, now(), messageId);
  return { ok: true, message: getMessage(messageId) };
}

function deleteMessage(messageId, userId) {
  const row = handle().prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
  if (!row) return { ok: false, error: 'Message not found.' };
  if (row.user_id !== userId) return { ok: false, error: 'You can only delete your own messages.' };
  if (row.deleted_at) return { ok: true, message: getMessage(messageId) };
  handle().prepare('UPDATE messages SET deleted_at = ?, body = ? WHERE id = ?').run(now(), '', messageId);
  return { ok: true, message: getMessage(messageId) };
}

/** Toggle a reaction; returns the updated message. */
function toggleReaction(messageId, userId, nickname, emoji) {
  const row = handle().prepare('SELECT id, deleted_at FROM messages WHERE id = ?').get(messageId);
  if (!row) return { ok: false, error: 'Message not found.' };
  if (row.deleted_at) return { ok: false, error: 'Message was deleted.' };
  const existing = handle()
    .prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
    .get(messageId, userId, emoji);
  if (existing) {
    handle()
      .prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
      .run(messageId, userId, emoji);
  } else {
    handle()
      .prepare('INSERT INTO reactions (message_id, user_id, nickname, emoji, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(messageId, userId, nickname, emoji, now());
  }
  return { ok: true, message: getMessage(messageId) };
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  DB_PATH,
  open,
  close,
  handle,
  // users
  authenticate,
  findUserByNickname,
  getUserById,
  touchLastSeen,
  getLastSeen,
  // rooms
  listRooms,
  getRoomByName,
  getRoomById,
  createRoom,
  joinRoom,
  leaveRoom,
  listMemberships,
  joinDefaultRooms,
  markRead,
  memberCounts,
  // messages
  insertMessage,
  getMessage,
  getRoomHistory,
  getDmHistory,
  countUnread,
  editMessage,
  deleteMessage,
  toggleReaction,
  dmKey
};

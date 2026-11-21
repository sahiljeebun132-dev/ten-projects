'use strict';

/**
 * SQLite persistence. One file, four tables:
 *   pairs    – a couple. Holds the one-time invite code until the partner joins.
 *   members  – a device/person in a pair. We store only a SHA-256 hash of its token.
 *   strokes  – every committed line on the shared canvas (normalised 0..1 coords).
 *   notes    – sticky notes left for each other.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const MAX_STROKES_PER_PAIR = 3000;
const MAX_NOTES_PER_PAIR = 60;
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
// No 0/O/1/I/L so codes are easy to read out loud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

let db;

function open(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'scribble.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS pairs (
      id           TEXT PRIMARY KEY,
      invite_code  TEXT UNIQUE,
      invite_until INTEGER,
      created_at   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      id         TEXT PRIMARY KEY,
      pair_id    TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      push_sub   TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS members_pair ON members(pair_id);
    CREATE TABLE IF NOT EXISTS strokes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      pair_id    TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
      member_id  TEXT NOT NULL,
      color      TEXT NOT NULL,
      width      REAL NOT NULL,
      erase      INTEGER NOT NULL DEFAULT 0,
      points     TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS strokes_pair ON strokes(pair_id, id);
    CREATE TABLE IF NOT EXISTS notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      pair_id    TEXT NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
      member_id  TEXT NOT NULL,
      text       TEXT NOT NULL,
      emoji      TEXT NOT NULL,
      color      TEXT NOT NULL,
      x          REAL NOT NULL,
      y          REAL NOT NULL,
      rot        REAL NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_pair ON notes(pair_id, id);
  `);
  return db;
}

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const newId = () => crypto.randomUUID();
const newToken = () => crypto.randomBytes(32).toString('base64url');

function newInviteCode() {
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

/* ----------------------------------------------------------- pairing */

function createPair(name) {
  const now = Date.now();
  const pairId = newId();
  const memberId = newId();
  const token = newToken();
  let inviteCode;
  const tx = db.transaction(() => {
    // Retry on the (astronomically unlikely) code collision.
    for (let i = 0; i < 5; i++) {
      inviteCode = newInviteCode();
      const clash = db.prepare('SELECT 1 FROM pairs WHERE invite_code = ?').get(inviteCode);
      if (!clash) break;
    }
    db.prepare('INSERT INTO pairs (id, invite_code, invite_until, created_at) VALUES (?,?,?,?)')
      .run(pairId, inviteCode, now + INVITE_TTL_MS, now);
    db.prepare('INSERT INTO members (id, pair_id, name, token_hash, created_at) VALUES (?,?,?,?,?)')
      .run(memberId, pairId, name, hashToken(token), now);
  });
  tx();
  return { token, inviteCode, memberId, pairId };
}

/** Returns { token, memberId, pairId } or { error } */
function joinPair(code, name) {
  const now = Date.now();
  let result;
  db.transaction(() => {
    const pair = db.prepare('SELECT * FROM pairs WHERE invite_code = ?').get(code);
    if (!pair || pair.invite_until < now) { result = { error: 'That code is not valid (or has expired).' }; return; }
    const count = db.prepare('SELECT COUNT(*) AS n FROM members WHERE pair_id = ?').get(pair.id).n;
    if (count >= 2) { result = { error: 'That code has already been used.' }; return; }
    const memberId = newId();
    const token = newToken();
    db.prepare('INSERT INTO members (id, pair_id, name, token_hash, created_at) VALUES (?,?,?,?,?)')
      .run(memberId, pair.id, name, hashToken(token), now);
    // One-time code: burn it so nobody else can join.
    db.prepare('UPDATE pairs SET invite_code = NULL, invite_until = NULL WHERE id = ?').run(pair.id);
    result = { token, memberId, pairId: pair.id };
  })();
  return result;
}

function memberByToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  return db.prepare('SELECT * FROM members WHERE token_hash = ?').get(hashToken(token)) || null;
}

function memberById(id) {
  return db.prepare('SELECT * FROM members WHERE id = ?').get(id) || null;
}

function partnerOf(member) {
  if (!member) return null;
  return db.prepare('SELECT * FROM members WHERE pair_id = ? AND id != ?').get(member.pair_id, member.id) || null;
}

function inviteFor(pairId) {
  const p = db.prepare('SELECT invite_code, invite_until FROM pairs WHERE id = ?').get(pairId);
  if (!p || !p.invite_code || p.invite_until < Date.now()) return null;
  return p.invite_code;
}

/** Fresh code for someone still waiting whose code expired. */
function refreshInvite(pairId) {
  const code = newInviteCode();
  db.prepare('UPDATE pairs SET invite_code = ?, invite_until = ? WHERE id = ?')
    .run(code, Date.now() + INVITE_TTL_MS, pairId);
  return code;
}

/** Leaving deletes your membership; the last one out deletes the whole pair + its canvas. */
function leave(member) {
  db.transaction(() => {
    db.prepare('DELETE FROM members WHERE id = ?').run(member.id);
    const left = db.prepare('SELECT COUNT(*) AS n FROM members WHERE pair_id = ?').get(member.pair_id).n;
    if (left === 0) db.prepare('DELETE FROM pairs WHERE id = ?').run(member.pair_id);
  })();
}

function setPushSubscription(memberId, sub) {
  db.prepare('UPDATE members SET push_sub = ? WHERE id = ?').run(sub ? JSON.stringify(sub) : null, memberId);
}

/* ----------------------------------------------------------- canvas */

const strokeRow = (r) => ({
  id: r.id, by: r.member_id, color: r.color, width: r.width, erase: !!r.erase, points: JSON.parse(r.points)
});

function addStroke(pairId, memberId, { color, width, erase, points }) {
  const info = db.prepare(
    'INSERT INTO strokes (pair_id, member_id, color, width, erase, points, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(pairId, memberId, color, width, erase ? 1 : 0, JSON.stringify(points), Date.now());
  // Keep the canvas bounded: drop the oldest strokes past the cap.
  db.prepare(`DELETE FROM strokes WHERE pair_id = ? AND id NOT IN
              (SELECT id FROM strokes WHERE pair_id = ? ORDER BY id DESC LIMIT ?)`)
    .run(pairId, pairId, MAX_STROKES_PER_PAIR);
  return Number(info.lastInsertRowid);
}

function strokesFor(pairId) {
  return db.prepare('SELECT * FROM strokes WHERE pair_id = ? ORDER BY id').all(pairId).map(strokeRow);
}

/** Undo: remove *my* most recent stroke. Returns its id or null. */
function undoLast(pairId, memberId) {
  const row = db.prepare('SELECT id FROM strokes WHERE pair_id = ? AND member_id = ? ORDER BY id DESC LIMIT 1')
    .get(pairId, memberId);
  if (!row) return null;
  db.prepare('DELETE FROM strokes WHERE id = ?').run(row.id);
  return row.id;
}

function clearCanvas(pairId) {
  db.prepare('DELETE FROM strokes WHERE pair_id = ?').run(pairId);
}

/* ----------------------------------------------------------- notes */

const noteRow = (r) => ({
  id: r.id, by: r.member_id, text: r.text, emoji: r.emoji, color: r.color, x: r.x, y: r.y, rot: r.rot, at: r.created_at
});

function addNote(pairId, memberId, { text, emoji, color }) {
  const x = 0.08 + Math.random() * 0.5;
  const y = 0.08 + Math.random() * 0.6;
  const rot = Math.round((Math.random() * 12 - 6) * 10) / 10;
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO notes (pair_id, member_id, text, emoji, color, x, y, rot, created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(pairId, memberId, text, emoji, color, x, y, rot, now);
  db.prepare(`DELETE FROM notes WHERE pair_id = ? AND id NOT IN
              (SELECT id FROM notes WHERE pair_id = ? ORDER BY id DESC LIMIT ?)`)
    .run(pairId, pairId, MAX_NOTES_PER_PAIR);
  return noteRow(db.prepare('SELECT * FROM notes WHERE id = ?').get(info.lastInsertRowid));
}

function notesFor(pairId) {
  return db.prepare('SELECT * FROM notes WHERE pair_id = ? ORDER BY id').all(pairId).map(noteRow);
}

function deleteNote(pairId, noteId) {
  return db.prepare('DELETE FROM notes WHERE id = ? AND pair_id = ?').run(noteId, pairId).changes > 0;
}

module.exports = {
  open, createPair, joinPair, memberByToken, memberById, partnerOf, inviteFor, refreshInvite, leave,
  setPushSubscription, addStroke, strokesFor, undoLast, clearCanvas, addNote, notesFor, deleteNote,
  MAX_STROKES_PER_PAIR, MAX_NOTES_PER_PAIR
};

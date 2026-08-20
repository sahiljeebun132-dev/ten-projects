'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, 'blog.sqlite');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

const db = new Database(DB_FILE);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Apply db/schema.sql when the core tables are missing.
 * Every statement in the schema is `IF NOT EXISTS`, so re-running is harmless.
 */
function migrate() {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('users','posts','tags','post_tags','comments')")
    .get();

  if (row.n < 5) {
    const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
    db.exec(sql);
    return true;
  }
  return false;
}

const applied = migrate();

module.exports = { db, migrate, applied, DB_FILE };

'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'store.sqlite');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);
}

function isInitialised() {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'")
    .get();
  return !!row;
}

module.exports = { db, DB_PATH, initSchema, isInitialised };

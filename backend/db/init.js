const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'blog.db');

let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

function initDb() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      summary TEXT,
      tags TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: optimistic-concurrency version column for existing databases
  const columns = db.prepare('PRAGMA table_info(articles)').all();
  if (!columns.some(col => col.name === 'version')) {
    db.exec('ALTER TABLE articles ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  }

  // Recoverable state: one row per write (create/update/delete/restore).
  // `snapshot` holds the article row as it was BEFORE the write; NULL means
  // the article did not exist. Restoring a revision applies its inverse.
  db.exec(`
    CREATE TABLE IF NOT EXISTS article_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      version INTEGER NOT NULL,
      snapshot TEXT,
      changed_fields TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_revisions_article
      ON article_revisions(article_id, id);
  `);

  // Idempotent writes: key -> captured response, so a retried/submitted
  // request after timeout or token refresh replays the original outcome
  // instead of writing twice.
  db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      username TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);

  console.log('Database initialized successfully');
  return db;
}

module.exports = initDb;
module.exports.getDb = getDb;

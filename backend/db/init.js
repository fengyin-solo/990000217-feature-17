const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'blog.db');

let db;

function getDb() {
  if (!db) {
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

function columnExists(db, table, column) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  return columns.some(c => c.name === column);
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

  // Optimistic concurrency: every successful write bumps the version.
  // Added via migration so existing databases keep working.
  if (!columnExists(db, 'articles', 'version')) {
    db.exec('ALTER TABLE articles ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  }

  // Server-side idempotency records so retries / duplicate submissions
  // replay the first response instead of performing the write twice.
  db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (idempotency_key, method, path)
    )
  `);

  console.log('Database initialized successfully');
  return db;
}

module.exports = initDb;
module.exports.getDb = getDb;

import { Database } from "bun:sqlite";

// Owned by one broker writer. No adapter opens a second write connection.
export function openDB(path = ":memory:"): Database {
  const db = new Database(path, { strict: true });
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT NOT NULL, session_alias TEXT NOT NULL, revision INTEGER NOT NULL,
      state TEXT NOT NULL, text TEXT NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL,
      dispatched_at REAL, acknowledged_at REAL, stop_at REAL, notices INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(id, revision)
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, revision INTEGER NOT NULL,
      delegation_id TEXT NOT NULL, state TEXT NOT NULL, created_at REAL NOT NULL,
      supersedes TEXT, UNIQUE(request_id, revision),
      FOREIGN KEY(request_id, revision) REFERENCES requests(id, revision)
    );
    CREATE TABLE IF NOT EXISTS results (
      request_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
      text TEXT NOT NULL, source TEXT NOT NULL, created_at REAL NOT NULL,
      UNIQUE(request_id, revision), FOREIGN KEY(request_id, revision) REFERENCES requests(id, revision)
    );
    CREATE TABLE IF NOT EXISTS delegations (
      id TEXT PRIMARY KEY, voice_epoch TEXT NOT NULL, offset_ms REAL NOT NULL,
      state TEXT NOT NULL, request_id TEXT, revision INTEGER, created_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage (
      voice_epoch TEXT PRIMARY KEY, seconds REAL NOT NULL, usd REAL NOT NULL, finalized INTEGER NOT NULL,
      day TEXT NOT NULL, last_activity_at REAL NOT NULL, close_requested INTEGER NOT NULL DEFAULT 0
    );
    PRAGMA user_version = 1;`);
  return db;
}

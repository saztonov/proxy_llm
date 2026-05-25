import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// SQL инлайнен сюда, чтобы tsc-сборка не требовала копировать .sql в dist/.
// Источник правды — этот файл; src/storage/migrations/001_initial.sql дублирует его для документации.
const MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  idempotency_key TEXT,
  upstream_id TEXT,
  ts_received INTEGER NOT NULL,
  ts_completed INTEGER,
  model_used TEXT,
  fallback_used INTEGER DEFAULT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  latency_ms INTEGER,
  request_bytes INTEGER,
  response_bytes INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  attempt_count INTEGER DEFAULT 1,
  retry_after_seconds INTEGER,
  error_code TEXT,
  error_msg TEXT,
  client_ip TEXT,
  source TEXT DEFAULT 'passdesk'
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts_received);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_idem ON requests(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_requests_upstream ON requests(upstream_id);
`;

export interface DbHandle {
  db: Database.Database;
  close(): void;
}

export function openDb(dbPath: string): DbHandle {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATION_001);

  return {
    db,
    close: () => db.close(),
  };
}

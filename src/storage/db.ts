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

/**
 * 003 — биллинг. Два уровня учёта:
 *   requests         — журнал входящих HTTP-запросов клиента (сколько пришло, latency, ошибки);
 *   billing_attempts — журнал фактических обращений к OpenRouter (одна строка = один платный
 *                      вызов). ВСЕ денежные и токенные агрегаты считаются только по нему.
 *
 * Разделение закрывает разом: dedup-join (N HTTP-запросов → одно выполнение → один набор
 * попыток), ретраи (2 попытки → 2 строки со своими токенами, моделями и generation ID) и
 * краш-устойчивость (попытка пишется до решения о ретрае).
 *
 * Деньги — REAL: usage.cost приходит от OpenRouter JSON-числом, и REAL хранит его бит-в-бит,
 * что позволяет построчно сверяться с инвойсом. Целочисленная шкала внесла бы нашу собственную
 * ошибку округления в единственные достоверные данные.
 * Цены каталога — TEXT decimal-строками как в каталоге; в число превращаются только при оценке.
 */
const MIGRATION_003 = `
CREATE TABLE IF NOT EXISTS billing_attempts (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id                TEXT NOT NULL,
  attempt_no                  INTEGER NOT NULL,
  request_id                  TEXT NOT NULL,
  client_id                   TEXT,
  payer_scope                 TEXT NOT NULL,
  api_key_fp                  TEXT,
  ts_started                  INTEGER NOT NULL,
  ts_completed                INTEGER NOT NULL,
  billing_day                 TEXT NOT NULL,
  http_status                 INTEGER,
  classification              TEXT NOT NULL,
  model_requested             TEXT,
  model_used                  TEXT,
  upstream_id                 TEXT,
  prompt_tokens               INTEGER,
  completion_tokens           INTEGER,
  total_tokens                INTEGER,
  cached_tokens               INTEGER,
  cache_write_tokens          INTEGER,
  reasoning_tokens            INTEGER,
  cost_usd                    REAL,
  upstream_inference_cost_usd REAL,
  is_byok                     INTEGER,
  usage_source                TEXT NOT NULL,
  cost_est_usd                REAL,
  est_quality                 TEXT,
  est_price_version           INTEGER,
  usage_json                  TEXT,
  UNIQUE(execution_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_ba_client_day ON billing_attempts(client_id, billing_day);
CREATE INDEX IF NOT EXISTS idx_ba_model_day  ON billing_attempts(model_used, billing_day);
CREATE INDEX IF NOT EXISTS idx_ba_day        ON billing_attempts(billing_day);
CREATE INDEX IF NOT EXISTS idx_ba_upstream   ON billing_attempts(upstream_id);
CREATE INDEX IF NOT EXISTS idx_ba_exec       ON billing_attempts(execution_id);

CREATE TABLE IF NOT EXISTS model_price_versions (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id                 TEXT NOT NULL,
  observed_at              INTEGER NOT NULL,
  observed_day             TEXT NOT NULL,
  pricing_hash             TEXT NOT NULL,
  pricing_json             TEXT NOT NULL,
  price_prompt             TEXT,
  price_completion         TEXT,
  price_cache_read         TEXT,
  price_cache_write        TEXT,
  price_request            TEXT,
  price_web_search         TEXT,
  price_internal_reasoning TEXT,
  has_overrides            INTEGER NOT NULL DEFAULT 0,
  has_sentinel             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mpv_lookup ON model_price_versions(model_id, observed_at);

CREATE TABLE IF NOT EXISTS price_sync_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  run_day          TEXT NOT NULL,
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER,
  ok               INTEGER NOT NULL,
  models_seen      INTEGER,
  versions_written INTEGER,
  http_status      INTEGER,
  error            TEXT
);
CREATE INDEX IF NOT EXISTS idx_psr_day ON price_sync_runs(run_day, ok);

CREATE TABLE IF NOT EXISTS billing_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface DbHandle {
  db: Database.Database;
  close(): void;
}

/** true, если в таблице уже есть колонка. SQLite не умеет ADD COLUMN IF NOT EXISTS. */
function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

/**
 * Аддитивные идемпотентные миграции поверх MIGRATION_001.
 * Каждая — no-op на уже мигрированной БД, безопасна на каждом старте.
 */
function applyAdditiveMigrations(db: Database.Database): void {
  // 002 — multi-tenant: колонка арендатора + индекс для пер-клиентских агрегатов.
  if (!hasColumn(db, 'requests', 'client_id')) {
    db.exec(`ALTER TABLE requests ADD COLUMN client_id TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_requests_client ON requests(client_id, ts_received)`);

  // 003 — биллинг. В requests только связка с ledger'ом и признаки; денег здесь нет.
  // billing_execution_id: N joined HTTP-запросов делят одно выполнение → одну группу attempts.
  if (!hasColumn(db, 'requests', 'billing_execution_id')) {
    db.exec(`ALTER TABLE requests ADD COLUMN billing_execution_id TEXT`);
  }
  if (!hasColumn(db, 'requests', 'dedup_join')) {
    db.exec(`ALTER TABLE requests ADD COLUMN dedup_join INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn(db, 'requests', 'model_requested')) {
    db.exec(`ALTER TABLE requests ADD COLUMN model_requested TEXT`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_requests_exec ON requests(billing_execution_id)`);
  db.exec(MIGRATION_003);

  // Дата, с которой денежный учёт достоверен: до неё стоимости нет и восстановить её нельзя.
  // Дашборд показывает это баннером, чтобы пустой период не читался как «ничего не тратили».
  db.prepare(
    `INSERT OR IGNORE INTO billing_meta (key, value) VALUES ('accounting_started_at', ?)`,
  ).run(String(Date.now()));
}

export function openDb(dbPath: string): DbHandle {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATION_001);
  applyAdditiveMigrations(db);

  return {
    db,
    close: () => db.close(),
  };
}

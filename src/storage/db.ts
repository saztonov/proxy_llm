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

/**
 * 004 — реестры админки: клиенты и токены сайтов (вместо clients.json), справочник отделов и
 * сотрудников, OpenAI-совместимые провайдеры, агентские токены, настройки, администраторы,
 * их сессии и аудит. Все таблицы новые, поэтому только CREATE ... IF NOT EXISTS.
 */
const MIGRATION_004 = `
-- ===== Контур сайтов: реестр клиентов и токенов (замена clients.json) =====
-- NULL в полях политики = наследовать env-дефолт, ровно как отсутствующее поле в clients.json;
-- '[]' в allowed_models_json = явный пин на defaultModel (перебивает CLIENT_DEFAULT_ALLOWED_MODELS).
CREATE TABLE IF NOT EXISTS site_clients (
  client_id               TEXT PRIMARY KEY,
  default_model           TEXT,
  allowed_models_json     TEXT,
  fallback_models_json    TEXT,
  max_concurrency         INTEGER CHECK (max_concurrency IS NULL OR max_concurrency BETWEEN 1 AND 20),
  max_pending             INTEGER CHECK (max_pending IS NULL OR max_pending BETWEEN 1 AND 1000),
  openrouter_api_key_enc  TEXT,
  openrouter_api_key_fp   TEXT,
  source                  TEXT,
  enabled                 INTEGER NOT NULL DEFAULT 1,
  imported_from           TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS site_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token_sha256  TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  token_prefix  TEXT,
  label         TEXT NOT NULL DEFAULT '',
  client_id     TEXT NOT NULL REFERENCES site_clients(client_id),
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  last_used_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_site_tokens_client ON site_tokens(client_id);

-- ===== Справочник отделов и сотрудников =====
-- Удаление только мягкое (enabled = 0): журнал ссылается на id. Лимиты NULL = дефолт из
-- settings / env AGENT_PRINCIPAL_*.
CREATE TABLE IF NOT EXISTS departments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  slug             TEXT NOT NULL UNIQUE,
  name             TEXT NOT NULL,
  max_concurrency  INTEGER CHECK (max_concurrency IS NULL OR max_concurrency BETWEEN 1 AND 200),
  max_pending      INTEGER CHECK (max_pending IS NULL OR max_pending BETWEEN 1 AND 1000),
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  login            TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name     TEXT NOT NULL,
  email            TEXT,
  department_id    INTEGER NOT NULL REFERENCES departments(id),
  max_concurrency  INTEGER CHECK (max_concurrency IS NULL OR max_concurrency BETWEEN 1 AND 200),
  max_pending      INTEGER CHECK (max_pending IS NULL OR max_pending BETWEEN 1 AND 1000),
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_employees_dept ON employees(department_id);

-- ===== Провайдеры (OpenAI-совместимые) =====
-- base_url — префикс до версии API включительно (https://openrouter.ai/api/v1): клиент дописывает
-- /chat/completions, как OpenAI SDK с baseURL. api_key_enc NULL = провайдер без ключа (Ollama).
-- extra_headers_enc шифруется целиком: в заголовках тоже бывают секреты.
CREATE TABLE IF NOT EXISTS providers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL UNIQUE,
  kind               TEXT NOT NULL DEFAULT 'openai_compatible' CHECK (kind IN ('openai_compatible')),
  base_url           TEXT NOT NULL,
  api_key_enc        TEXT,
  api_key_fp         TEXT,
  extra_headers_enc  TEXT,
  usage_mode         TEXT NOT NULL DEFAULT 'auto'
                       CHECK (usage_mode IN ('auto', 'openrouter', 'stream_options', 'none')),
  max_concurrency    INTEGER CHECK (max_concurrency IS NULL OR max_concurrency BETWEEN 1 AND 500),
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- ===== Агентские токены =====
-- Принципал ровно один: отдел ИЛИ сотрудник. provider_id + model либо оба заданы
-- (принудительная модель токена), либо оба NULL (глобальный дефолт из settings).
CREATE TABLE IF NOT EXISTS agent_tokens (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  token_sha256        TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  token_prefix        TEXT NOT NULL,
  label               TEXT NOT NULL DEFAULT '',
  principal_type      TEXT NOT NULL CHECK (principal_type IN ('department', 'employee')),
  department_id       INTEGER REFERENCES departments(id),
  employee_id         INTEGER REFERENCES employees(id),
  provider_id         INTEGER REFERENCES providers(id),
  model               TEXT,
  allowed_cidrs_json  TEXT,
  expires_at          INTEGER,
  enabled             INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  revoked_at          INTEGER,
  last_used_at        INTEGER,
  CHECK ((principal_type = 'department' AND department_id IS NOT NULL AND employee_id IS NULL)
      OR (principal_type = 'employee'   AND employee_id  IS NOT NULL AND department_id IS NULL)),
  CHECK ((provider_id IS NULL) = (model IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_dept     ON agent_tokens(department_id);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_emp      ON agent_tokens(employee_id);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_provider ON agent_tokens(provider_id);

-- ===== Настройки, редактируемые из админки =====
-- agent_default_provider_id, agent_default_model, agent_default_max_concurrency,
-- agent_default_max_pending, site_bootstrap (JSON-маркер завершённого импорта clients.json).
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ===== Администраторы и их сессии =====
CREATE TABLE IF NOT EXISTS admin_users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  login          TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash  TEXT NOT NULL,
  display_name   TEXT NOT NULL DEFAULT '',
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

-- Refresh-сессии с ротацией: на каждый refresh новая строка, у старой replaced_by_id.
-- Повторное предъявление заменённого токена вне grace-окна = кража, отзыв всей family_id.
-- Access-JWT несёт family_id и на каждом запросе сверяется с этой таблицей, поэтому отзыв
-- (logout, смена пароля, CLI revoke-sessions) действует немедленно и переживает рестарт.
CREATE TABLE IF NOT EXISTS admin_sessions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id             INTEGER NOT NULL REFERENCES admin_users(id),
  token_sha256         TEXT NOT NULL UNIQUE,
  family_id            TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  expires_at           INTEGER NOT NULL,
  absolute_expires_at  INTEGER NOT NULL,
  last_used_at         INTEGER,
  revoked_at           INTEGER,
  revoke_reason        TEXT,
  replaced_by_id       INTEGER,
  replaced_at          INTEGER,
  ip                   TEXT,
  user_agent           TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_family ON admin_sessions(family_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin  ON admin_sessions(admin_id);

-- Журнал действий администраторов. details_json собирается из белого списка полей:
-- ни токенов, ни ключей, ни паролей здесь не бывает.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  admin_id     INTEGER,
  admin_login  TEXT,
  ip           TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  details_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON admin_audit_log(ts);
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

  // 004 — реестры админки + атрибуция журнала по контуру, токену, отделу, сотруднику, провайдеру.
  db.exec(MIGRATION_004);
  // contour: 'site' | 'agent'. ADD COLUMN с константным DEFAULT заполняет старые строки сам —
  // вся история до миграции относится к контуру сайтов, бэкфилл не нужен.
  // Внешних ключей в журнале нет намеренно: запись о запросе не должна зависеть от судьбы
  // справочника, а справочники удаляются только мягко.
  for (const table of ['requests', 'billing_attempts'] as const) {
    if (!hasColumn(db, table, 'contour')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN contour TEXT NOT NULL DEFAULT 'site'`);
    }
    for (const col of ['token_id', 'department_id', 'employee_id'] as const) {
      if (!hasColumn(db, table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} INTEGER`);
    }
  }
  if (!hasColumn(db, 'billing_attempts', 'provider_id')) {
    db.exec(`ALTER TABLE billing_attempts ADD COLUMN provider_id INTEGER`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_requests_contour_ts ON requests(contour, ts_received);
    CREATE INDEX IF NOT EXISTS idx_requests_dept       ON requests(department_id, ts_received);
    CREATE INDEX IF NOT EXISTS idx_ba_contour_day      ON billing_attempts(contour, billing_day);
    CREATE INDEX IF NOT EXISTS idx_ba_dept_day         ON billing_attempts(department_id, billing_day);
    CREATE INDEX IF NOT EXISTS idx_ba_emp_day          ON billing_attempts(employee_id, billing_day);
    CREATE INDEX IF NOT EXISTS idx_ba_token_day        ON billing_attempts(token_id, billing_day);
    CREATE INDEX IF NOT EXISTS idx_ba_provider_day     ON billing_attempts(provider_id, billing_day);
  `);
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

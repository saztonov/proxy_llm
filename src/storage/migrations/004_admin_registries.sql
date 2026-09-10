-- 004 — реестры админки: сайты и токены в БД, справочник, провайдеры, агентские токены,
-- настройки, администраторы, аудит. ДОКУМЕНТАЦИОННЫЙ ДУБЛЬ: источник правды — MIGRATION_004
-- в src/storage/db.ts, применяется идемпотентно при каждом старте. Плюс аддитивные колонки
-- журнала (contour, token_id, department_id, employee_id, provider_id) в applyAdditiveMigrations.

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

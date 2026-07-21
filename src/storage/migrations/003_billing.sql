-- 003 — учёт расходов.
--
-- ДОКУМЕНТАЦИОННЫЙ ДУБЛЬ. Источник правды — src/storage/db.ts (MIGRATION_003 +
-- applyAdditiveMigrations). Вручную этот файл выполнять не нужно: миграции применяются
-- идемпотентно на каждом старте сервиса.
--
-- Два уровня учёта:
--   requests         — журнал входящих HTTP-запросов клиента (нагрузка, latency, ошибки);
--   billing_attempts — журнал фактических обращений к OpenRouter, одна строка = один
--                      платный вызов. ВСЕ денежные и токенные агрегаты считаются по нему.
--
-- Разделение закрывает: dedup-join (N HTTP-запросов → одно выполнение → один набор
-- попыток), ретраи (2 попытки → 2 строки со своими токенами и generation ID) и
-- краш-устойчивость (попытка пишется до решения о ретрае).

ALTER TABLE requests ADD COLUMN billing_execution_id TEXT;
ALTER TABLE requests ADD COLUMN dedup_join INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN model_requested TEXT;
CREATE INDEX IF NOT EXISTS idx_requests_exec ON requests(billing_execution_id);

-- Деньги — REAL: usage.cost приходит от OpenRouter JSON-числом, и REAL хранит его
-- бит-в-бит, что позволяет построчно сверяться с инвойсом.
CREATE TABLE IF NOT EXISTS billing_attempts (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id                TEXT NOT NULL,
  attempt_no                  INTEGER NOT NULL,
  request_id                  TEXT NOT NULL,
  client_id                   TEXT,
  payer_scope                 TEXT NOT NULL,   -- 'global' | clientId
  api_key_fp                  TEXT,            -- 16 hex от sha256(ключа)
  ts_started                  INTEGER NOT NULL,
  ts_completed                INTEGER NOT NULL,
  billing_day                 TEXT NOT NULL,   -- 'YYYY-MM-DD' в BILLING_TIMEZONE
  http_status                 INTEGER,
  classification              TEXT NOT NULL,
  model_requested             TEXT,
  model_used                  TEXT,
  upstream_id                 TEXT,            -- generation ID для сверки с инвойсом
  prompt_tokens               INTEGER,
  completion_tokens           INTEGER,
  total_tokens                INTEGER,
  cached_tokens               INTEGER,
  cache_write_tokens          INTEGER,
  reasoning_tokens            INTEGER,
  cost_usd                    REAL,            -- единственный бухгалтерский факт
  upstream_inference_cost_usd REAL,
  is_byok                     INTEGER,
  usage_source                TEXT NOT NULL,   -- 'response' | 'missing'
  cost_est_usd                REAL,            -- диагностика, в итоги не входит
  est_quality                 TEXT,            -- 'ok' | 'partial' | 'no_price' | 'unpriceable'
  est_price_version           INTEGER,
  usage_json                  TEXT,
  UNIQUE(execution_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_ba_client_day ON billing_attempts(client_id, billing_day);
CREATE INDEX IF NOT EXISTS idx_ba_model_day  ON billing_attempts(model_used, billing_day);
CREATE INDEX IF NOT EXISTS idx_ba_day        ON billing_attempts(billing_day);
CREATE INDEX IF NOT EXISTS idx_ba_upstream   ON billing_attempts(upstream_id);
CREATE INDEX IF NOT EXISTS idx_ba_exec       ON billing_attempts(execution_id);

-- История цен: новая версия только при изменении pricing. Каталог отдаёт ТЕКУЩИЕ цены,
-- задним числом историю не восстановить, поэтому ретеншна нет. observed_at — когда МЫ
-- увидели цену, а не когда она вступила в силу.
CREATE TABLE IF NOT EXISTS model_price_versions (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id                 TEXT NOT NULL,
  observed_at              INTEGER NOT NULL,
  observed_day             TEXT NOT NULL,
  pricing_hash             TEXT NOT NULL,
  pricing_json             TEXT NOT NULL,
  price_prompt             TEXT,               -- decimal-строки как в каталоге
  price_completion         TEXT,
  price_cache_read         TEXT,
  price_cache_write        TEXT,
  price_request            TEXT,
  price_web_search         TEXT,
  price_internal_reasoning TEXT,
  has_overrides            INTEGER NOT NULL DEFAULT 0,  -- ступени по длине промпта
  has_sentinel             INTEGER NOT NULL DEFAULT 0   -- цена < 0 (роутеры отдают "-1")
);
CREATE INDEX IF NOT EXISTS idx_mpv_lookup ON model_price_versions(model_id, observed_at);

-- Подтверждает, что неизменившийся прайс тоже проверяли, и фиксирует неудачи.
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

-- accounting_started_at — момент первой миграции: до него стоимости в журнале нет и
-- восстановить её нельзя.
CREATE TABLE IF NOT EXISTS billing_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

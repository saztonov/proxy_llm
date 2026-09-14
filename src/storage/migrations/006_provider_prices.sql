-- 006 — цены моделей провайдеров агентского контура (документационная копия; применяется
-- из src/storage/db.ts, MIGRATION_006). Каждое сохранение цены — новая версия.
CREATE TABLE IF NOT EXISTS provider_model_prices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id     INTEGER NOT NULL REFERENCES providers(id),
  model           TEXT NOT NULL,
  effective_from  INTEGER NOT NULL,
  price_json      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  created_by      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pmp_lookup ON provider_model_prices(provider_id, model, effective_from);

-- Какой версией цены оценена попытка (NULL — оценка по каталогу OpenRouter или её нет).
ALTER TABLE billing_attempts ADD COLUMN est_provider_price_id INTEGER;

-- proxy_llm — multi-tenant: колонка арендатора в журнале.
-- Источник правды — inlined-миграция в src/storage/db.ts (applyAdditiveMigrations).
-- Этот файл дублирует её для документации. Применяется идемпотентно на каждом старте
-- (guard через PRAGMA table_info, т.к. SQLite не умеет ADD COLUMN IF NOT EXISTS).

ALTER TABLE requests ADD COLUMN client_id TEXT;
CREATE INDEX IF NOT EXISTS idx_requests_client ON requests(client_id, ts_received);

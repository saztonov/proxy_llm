-- 005 — комментарий к агентскому ключу. ДОКУМЕНТАЦИОННЫЙ ДУБЛЬ: источник правды —
-- applyAdditiveMigrations в src/storage/db.ts (колонка добавляется, только если её ещё нет).
-- Свободный текст админа до 500 символов; в интерфейсе показывается по наведению на пиктограмму.
ALTER TABLE agent_tokens ADD COLUMN comment TEXT NOT NULL DEFAULT '';

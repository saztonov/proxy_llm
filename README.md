# proxy_llm

OpenAI-совместимый прокси между PassDesk и OpenRouter с журналом, алертами и dashboard.

## Зачем

- **Изолировать ключ OpenRouter** — настоящий ключ живёт ТОЛЬКО на VPS прокси, в PassDesk его нет.
- **Централизованный журнал** всех LLM-вызовов с `upstream_id` для биллинг-сверки.
- **Алерты в Telegram** при ошибках/перегрузке.
- **Dashboard** с агрегатами и p95 latency.

PassDesk-сторона меняется минимально: две env-переменные + два HTTP-заголовка в исходящем axios-вызове.

## Архитектурный принцип

Прокси **не очередь**. Source of truth для OCR-задачи остаётся в PassDesk BullMQ. Прокси отвечает только за один HTTP-вызов в OpenRouter: валидацию, model override, retry с deadline, журнал, алерты.

См. [docs/architecture.md](docs/architecture.md).

## Быстрый старт

### Локальная разработка

```bash
npm ci
cp .env.example .env.local
# подправить PROXY_INBOUND_TOKEN, OPENROUTER_API_KEY, DB_PATH=./data/dev.db
npm run dev
```

### Тесты

```bash
npm test
```

60 тестов, покрывают: классификацию ответов (включая HTTP 200 + body.error и malformed_success), retry policy с Retry-After в двух форматах, dedup с hard cap, header whitelist, response body limit, deadline-aware behavior, admission control, streaming rejection.

### Build

```bash
npm run build       # tsc → dist/
npm start           # node dist/server.js
```

### Развёртывание на VPS

См. [deploy/INSTALL.md](deploy/INSTALL.md) — пошаговые команды для Ubuntu 22.04/24.04 с указанием пользователей (root vs proxy_llm).

### Миграция PassDesk

См. [docs/passdesk-migration.md](docs/passdesk-migration.md) — что менять в env и `ocrService.js`.

Если хотите делегировать миграцию LLM-агенту — есть готовый промт в [docs/passdesk-agent-prompt.md](docs/passdesk-agent-prompt.md).

## Что прокси гарантирует

- **`stream:true` запрещён** (400) — упрощает retry/timeout/journal.
- **`model` всегда из env прокси**, не из клиентского payload. Клиентский `model` молча удаляется. Аналогично — `provider`, `route`, `transforms`, `plugins`, `stream_options`, `debug`.
- **HTTP 200 ≠ success автоматически.** Если в JSON-теле есть `error` или пустые `choices` — это `body_level_error` / `malformed_success` в журнале.
- **Idempotency** через `X-Idempotency-Key`: параллельные запросы с одним ключом получают один upstream-вызов. Hard cap (1000 активных ключей), без LRU eviction.
- **Общий deadline** `REQUEST_DEADLINE_MS=190s` покрывает все попытки + backoff. nginx `proxy_read_timeout=220s` — 504 формирует прокси, не nginx.
- **Response body limit** `2 MB` — защита от мусора провайдера.
- **Никаких тел запроса/ответа в журнале** — только метаданные. `pino-redact` на секреты и bodies.
- **Никакого cold-replay после крэша** — PassDesk BullMQ сам ретраит.

## Технологии

| Слой | Выбор |
|---|---|
| Runtime | Node.js 22 LTS + TypeScript 5 |
| HTTP-сервер | Fastify 5 |
| HTTP-клиент | undici |
| Очередь in-process | p-queue (НЕ source of truth) |
| Журнал | better-sqlite3 (WAL, busy_timeout=5000) |
| Логи | pino + redact |
| Валидация | zod |
| Шаблоны dashboard | eta |
| Тесты | vitest |
| Деплой | systemd + nginx, без Docker |

## Структура

```
proxy_llm/
├── src/
│   ├── server.ts                 bootstrap + graceful shutdown
│   ├── app.ts                    сборка Fastify app (для тестов и server.ts)
│   ├── config.ts                 zod-схема env
│   ├── routes/                   HTTP endpoints
│   ├── upstream/                 OpenRouter client + retry + classification
│   ├── dedup/                    active-request dedup
│   ├── auth/                     Bearer / Basic
│   ├── alerts/                   Telegram + rules + daily digest
│   ├── watchdog/                 startup-alert + ticker
│   ├── storage/                  better-sqlite3 + requests-repo
│   ├── views/                    dashboard.eta
│   └── utils/                    logger, ids, sanitize
├── test/                         60 vitest-тестов
├── deploy/
│   ├── systemd/proxy_llm.service
│   ├── nginx/proxy_llm.conf
│   └── INSTALL.md                пошаговое развёртывание
├── docs/
│   ├── architecture.md
│   ├── passdesk-migration.md
│   ├── passdesk-agent-prompt.md
│   ├── runbook.md
│   └── alerts-glossary.md
└── scripts/
    ├── backup-db.sh
    ├── wal-checkpoint.sh
    └── rotate-logs.sh
```

## Дополнительно

Копия эксплуатационных документов лежит также в `c:\Users\Usr\claudeprojects\docs\proxy_llm\` — чтобы их можно было читать без клона репозитория.

## Лицензия

Внутренний инструмент, лицензии нет.

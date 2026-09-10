# proxy_llm

OpenAI-совместимый прокси между порталами и LLM-провайдерами с журналом, учётом расходов, алертами и админ-сайтом.

Два контура:
- **сайты** (`/api/v1`) — порталы PassDesk, FOT, MatCheck, EstiMat, как и раньше;
- **агенты** (`/agent/v1`) — OpenAI API для Cursor и других агентов сотрудников: ключ на отдел или сотрудника, модель назначает администратор ([docs/agents.md](docs/agents.md)).

Управление — админ-сайт `/admin`: сайты и токены, справочник отделов и сотрудников, провайдеры, агентские ключи, статистика, аудит.

## Зачем

- **Изолировать ключ OpenRouter** — настоящий ключ живёт ТОЛЬКО на VPS прокси, в PassDesk его нет.
- **Централизованный журнал** всех LLM-вызовов с `upstream_id` для биллинг-сверки.
- **Алерты в Telegram** при ошибках/перегрузке.
- **Dashboard** с агрегатами и p95 latency.

PassDesk-сторона меняется минимально: две env-переменные + два HTTP-заголовка в исходящем axios-вызове.

## Архитектурный принцип

Прокси **не очередь**. Source of truth для OCR-задачи остаётся в PassDesk BullMQ. Прокси отвечает только за один HTTP-вызов в OpenRouter: валидацию, резолв модели по политике клиента, retry с deadline, журнал, алерты.

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

Около 370 тестов: классификация ответов и retry policy, dedup, admission control и fairness обоих контуров, реестры в БД и их горячая перезагрузка, стриминг агентов (обрыв клиента, таймауты, usage после finish_reason), 40 одновременных пользователей, авторизация админки (ротация refresh, отзыв, CSRF, Origin), CLI, остановка сервиса.

### Build

```bash
npm run build       # tsc → dist/
npm start           # node dist/server.js
```

### Развёртывание на VPS

- **[docs/operator-guide.md](docs/operator-guide.md)** — полное руководство админа: подготовка VPS, развёртывание с нуля, генерация и передача токена в PassDesk, проверка end-to-end, эксплуатация, ротация секретов. Начинать с него.
- [deploy/INSTALL.md](deploy/INSTALL.md) — более компактный справочник команд.
- [docs/vps-update.md](docs/vps-update.md) — чек-лист обновления уже работающего VPS и подключения нового потребителя (токены, лимиты, модели). **§0a — разовый переход на версию с админкой и агентским контуром.**
- [docs/agents.md](docs/agents.md) — подключение Cursor, Continue, Cline, Aider и OpenAI SDK к агентскому контуру; ёмкость и лимиты.

### Миграция PassDesk

См. [docs/passdesk-migration.md](docs/passdesk-migration.md) — что менять в env и `ocrService.js`.

Если хотите делегировать миграцию LLM-агенту — есть готовый промт в [docs/passdesk-agent-prompt.md](docs/passdesk-agent-prompt.md).

## Что прокси гарантирует

- **`stream:true` в контуре сайтов запрещён** (400) — упрощает retry/timeout/journal. Агентский контур стримит.
- **`model` — по политике клиента** из `clients.json`. `allowedModels` пуст → клиентский `model` игнорируется, идёт `defaultModel` клиента + его fallback-цепочка (поведение по умолчанию). Список или `["*"]` → клиент выбирает сам; модель вне списка → 400 `model_not_allowed`. Явный выбор **отключает** fallback-цепочку. Заглушки `proxy`/`default`/`auto` в поле `model` = «модель не выбрана» → дефолт клиента. Подробнее — [docs/vps-update.md](docs/vps-update.md) §4a.
- **Всегда молча удаляются** из payload: `models` (свою fallback-цепочку прислать нельзя), `provider`, `route`, `transforms`, `plugins`, `stream_options`, `debug`.
- **Qwen (`qwen/*`)** — прокси сам добавляет `reasoning.effort=none`, `enable_thinking=false` и `chat_template_kwargs.enable_thinking=false`, если клиент их не задал явно (hybrid-модели иначе съедают `max_tokens` на thinking).
- **HTTP 200 ≠ success автоматически.** Если в JSON-теле есть `error` или пустые `choices` — это `body_level_error` / `malformed_success` в журнале.
- **Idempotency** через `X-Idempotency-Key`: параллельные запросы с одним ключом получают один upstream-вызов. Hard cap (1000 активных ключей), без LRU eviction.
- **Общий deadline** `REQUEST_DEADLINE_MS=420s` покрывает все попытки + backoff. nginx `proxy_read_timeout=480s` — 504 формирует прокси, не nginx.
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
│   ├── routes/                   HTTP endpoints контура сайтов и /dashboard
│   ├── agent/                    агентский контур /agent/v1 (auth, стриминг, лимиты)
│   ├── admin/                    админ-сайт /admin (сессии, CSRF, JSON API, рендер)
│   ├── journal/                  общий журнал и ledger для двух контуров
│   ├── cli/                      admin.js: первый админ, токены, импорт, rekey
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
│   ├── operator-guide.md
│   ├── vps-update.md              обновление VPS + онбординг клиента
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

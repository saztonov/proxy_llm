# Архитектура proxy_llm

## Однострочно

OpenAI-совместимый HTTP-прокси между PassDesk и OpenRouter с журналом, алертами и dashboard. Цель — изолировать ключ OpenRouter и получить централизованный контроль/наблюдаемость.

С версии 2026-09 у прокси два контура и админ-сайт — см. раздел «Два контура и админ-сайт» в конце. Всё, что описано до него, относится к контуру сайтов.

## Что прокси делает (и чего НЕ делает)

**Делает:**
- Принимает `POST /api/v1/chat/completions` от клиента с `Authorization: Bearer <токен клиента>`; токен резолвится в `clientId` через реестр `clients.json`.
- Валидирует payload (zod), запрещает `stream:true`, очищает denylist полей.
- Резолвит `model` / `models` по политике клиента: `allowedModels` пуст → форс `defaultModel` (клиентский `model` игнорируется); список или `["*"]` → выбор клиента, модель вне списка → 400 `model_not_allowed`; заглушки `proxy`/`default`/`auto` = «не выбрано». Явный выбор отключает fallback-цепочку. Клиентский `models[]` вырезается всегда.
- Отправляет в OpenRouter с настоящим `OPENROUTER_API_KEY`.
- Ретраит retryable-ошибки внутри общего deadline.
- Пишет метаданные каждой попытки в SQLite (без тел запроса/ответа).
- Алертит в Telegram при ошибках/перегрузке.
- Отдаёт dashboard под Basic Auth.

**НЕ делает:**
- НЕ владеет OCR-задачей. Source of truth — PassDesk BullMQ.
- НЕ хранит сканы паспортов или другие PII в SQLite.
- НЕ делает cold-replay после крэша.
- НЕ поддерживает streaming в контуре сайтов (агентский контур поддерживает — см. ниже).
- НЕ доверяет клиенту в части `provider` / `route` / `transforms` / `plugins` / `models[]` (denylist). Выбор **модели** — отдельный случай: он может быть делегирован клиенту через `allowedModels`, это решение оператора.
- НЕ проверяет существование модели: опечатка в слаге вскроется только ошибкой от OpenRouter.

## Поток одного запроса

```
Клиент (напр. PassDesk BullMQ retry attempt)
     │ HTTPS, Bearer <токен клиента>, X-Request-Id, X-Idempotency-Key
     ▼
nginx (TLS, IP-allowlist клиентов, limit_conn=3, limit_req=60/min)
     │ proxy_pass 127.0.0.1:3000
     ▼
Fastify onRequest hook (admission control ДО парсинга body)
     │ Bearer check (→ clientId) / Content-Length check / queue depth check
     │ если перегружены — 503 СРАЗУ, body не читается
     ▼
Fastify body parsing + zod validation
     │ stream:true → 400; messages пустой → 400
     ▼
resolveModel: политика клиента (allowedModels)
     │ модель вне списка → 400 model_not_allowed, до OpenRouter не доходит
     ▼
Active dedup (Map<clientId:X-Idempotency-Key, Promise<ProxyResult>>)
     │ hard cap 1000, без LRU eviction; ключ скоупится по клиенту
     │ если ключ уже активен — await тот же promise (один upstream вызов на два запроса)
     ▼
Пер-клиентская очередь (maxConcurrency) → глобальный семафор (QUEUE_CONCURRENCY)
     │
     ▼
Цикл попыток с REQUEST_DEADLINE_MS
     │ перед каждой attempt — проверка остатка deadline
     │ undici.request → OpenRouter, X-OpenRouter-Title, AbortSignal.timeout(attemptTimeout)
     │ body прочитан с UPSTREAM_RESPONSE_BODY_LIMIT_BYTES — иначе 502
     │ classification: success / body_level_error / malformed_success / upstream_error
     ▼
INSERT в requests (метаданные + upstream_id для биллинг-сверки)
     │
     ▼
Response клиенту (whitelist headers: content-type, X-Proxy-Request-Id, X-OpenRouter-Request-Id)
```

## Безопасность ключей

| Где | Переменная | Значение | Кто видит |
|---|---|---|---|
| Прокси `/etc/proxy_llm/.env` | `OPENROUTER_API_KEY` | настоящий ключ OpenRouter (общий, если у клиента нет своего) | root + proxy_llm |
| Прокси `/etc/proxy_llm/clients.json` | `tokens[]` / `tokenSha256[]` | пер-клиентские токены; опц. `openrouterApiKey` для биллинговой изоляции | root + proxy_llm |
| Прокси `/etc/proxy_llm/.env` | `PROXY_INBOUND_TOKEN` | `openssl rand -hex 32`; legacy-токен, всегда резолвится в клиента `passdesk` | root + админ PassDesk |
| PassDesk `.env` | `OCR_API_KEY` | токен клиента `passdesk` | админ PassDesk |
| Прокси `/etc/proxy_llm/.env` | `DASHBOARD_BASIC_AUTH_PASS` | сильный пароль | root + админ |

- `PROXY_INBOUND_TOKEN` НИКОГДА не уходит в OpenRouter (прокси перезаписывает Authorization).
- `OPENROUTER_API_KEY` НИКОГДА не возвращается клиенту и НИКОГДА не пишется в логи (pino redact).
- Тела запроса/ответа НИКОГДА не пишутся в логи, SQLite, alert-сообщения.

## Retry policy

```text
Бюджеты:
  REQUEST_DEADLINE_MS         = 420000   общий потолок со всеми попытками
  UPSTREAM_ATTEMPT_TIMEOUT_MS = 360000   одна попытка
  UPSTREAM_MAX_ATTEMPTS       = 2
  MIN_REMAINING_MS            = 10000    если меньше — новую попытку не начинаем

Наружу:
  nginx proxy_read_timeout / proxy_send_timeout = 480s   (> REQUEST_DEADLINE_MS)
  id.su10 LLM_TIMEOUT_MS                          = 450000 (> REQUEST_DEADLINE_MS)
  PassDesk axios timeout (OCR_SCAN_REQUEST_TIMEOUT_MS)   ≥ 460s

НЕ ретраить:
  400, 401 (немедленный алерт), 402 (немедленный алерт), 403
  body-level: moderation, content_policy

Ретраить:
  408, 429 (с Retry-After), 500, 502, 503 (с Retry-After), 504
  network: ECONNRESET, ETIMEDOUT, abort
  body-level retryable codes: provider_unavailable, timeout, internal_error, и др.
```

## Алерты

| Событие | Cooldown |
|---|---|
| OpenRouter 401 / 402 | без cooldown, критично |
| Серия ошибок ≥5 подряд | 10 мин |
| Error rate >30% за 50 запросов | 30 мин |
| OpenRouter недоступен | 5 мин |
| Долгий запрос >150s | per-request |
| Stuck request (watchdog) | per-request |
| Прокси перезапущен | без cooldown |
| Мало места на диске | 24 ч |
| Daily digest | 09:00 МСК |

## SQLite-схема

Единственная таблица `requests`. Хранит:
- `request_id` (per attempt), `idempotency_key` (per OCR-job), `upstream_id` (OpenRouter `gen-…`);
- timestamps, latency, размеры запроса/ответа;
- `model_used`, `fallback_used` (best-effort: 1/0/null; при явном выборе модели цепочки нет, поэтому `null` встречается чаще);
- статус, http_status, attempt_count;
- `error_code`, `error_msg` (truncate 500, sanitized);
- `client_ip`, `source`, `client_id` (миграция `002_add_client_id.sql`).

Что клиент **прислал** в поле `model`, журнал не хранит — только `model_used` (что отработало).

WAL-mode, `busy_timeout=5000`. Еженедельный `wal_checkpoint(TRUNCATE)` через cron.

## Изоляция от соседних порталов

- Отдельный пользователь `proxy_llm` без shell.
- `MemoryMax=1G`, `CPUQuota=80%`, `IOWeight=50` через systemd.
- Sandboxing: `ProtectSystem=strict`, `PrivateTmp=true`, capability set очищен.
- НЕ включено: `MemoryDenyWriteExecute=true` (ломает V8 JIT), `SystemCallFilter=@system-service` (ломает native modules).
- nginx vhost изолирован — никаких правок в общем nginx.conf.
- Listen только на `127.0.0.1:3000`, наружу через nginx.

См. [deploy/INSTALL.md](../deploy/INSTALL.md) для пошаговых команд развёртывания и [docs/passdesk-migration.md](passdesk-migration.md) для миграции PassDesk.

## Два контура и админ-сайт

| | Сайты (`/api/v1`, алиас `/v1`) | Агенты (`/agent/v1`) |
|---|---|---|
| Кто ходит | порталы (PassDesk, FOT, MatCheck, EstiMat) | IDE и агенты сотрудников (Cursor, Continue, Cline, SDK) |
| Токен | `clientId` сайта; старые токены работают как прежде | `pl_agent_…` на отдел или сотрудника |
| Модель | политика клиента (`allowedModels`, дефолт, fallback) | принудительная: модель ключа или глобальный дефолт |
| Провайдер | OpenRouter | любой OpenAI-совместимый из справочника |
| Стриминг | запрещён | SSE как есть, ретрай только до первого байта |
| Формат ошибок | `{error:{code,message}}` | формат OpenAI `{error:{message,type,param,code}}` |
| Очередь | `QUEUE_*`, слоты на клиента | отдельный `FairnessManager`: `AGENT_QUEUE_*`, слоты на владельца ключа |
| nginx | IP-allowlist | без allowlist (Cursor ходит из облака), мягкие лимиты на IP |

**Реестры в SQLite.** Клиенты и токены сайтов, справочник, провайдеры и агентские ключи хранятся в БД; в памяти — неизменяемые снапшоты, которые подменяются после каждого изменения из админки (prepare-then-publish: запись, аудит и сборка снапшотов в одной транзакции). `clients.json` и `PROXY_INBOUND_TOKEN` импортируются один раз при первом старте, дальше файл не читается. Токены хранятся только как sha256; ключи провайдеров и собственные ключи OpenRouter сайтов зашифрованы AES-256-GCM ключом `SECRETS_ENCRYPTION_KEY`.

**Журнал.** В `requests` и `billing_attempts` добавлены `contour`, `token_id`, `department_id`, `employee_id`, `provider_id`. Оперативные метрики, error-rate алерт и старый `/dashboard` считаются по контуру сайтов; отмена запроса пользователем (`client_aborted`) ошибкой не считается.

**Админ-сайт** (`/admin`, под IP-allowlist в nginx) — вход только для администраторов: scrypt, access-JWT 15 мин и refresh с ротацией в httpOnly cookie, проверка сессии по БД на каждом запросе, CSRF-токен + проверка Origin, CSP без inline-кода, аудит действий. Подробности и восстановление — `docs/operator-guide.md`, раздел «Админ-сайт и агентский контур».

**Остановка.** Таймер drain взводится до `app.close()`: по истечении `GRACEFUL_DRAIN_MS` живые запросы обоих контуров получают abort (стримы — синтетическое error-событие), каждый пишет свою строку журнала, затем закрывается БД. `TimeoutStopSec` юнита должен быть больше `GRACEFUL_DRAIN_MS` примерно на 15 секунд.

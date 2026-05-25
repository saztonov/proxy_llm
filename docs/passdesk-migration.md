# Миграция PassDesk на proxy_llm

Этот документ описывает шаги переключения OCR-функции PassDesk с прямых вызовов `openrouter.ai` на прокси-сервис `proxy_llm`. Цель — полностью убрать ключ OpenRouter из PassDesk env и получить централизованный журнал/алерты.

## Кратко

1. На VPS поднят `proxy_llm` ([deploy/INSTALL.md](../deploy/INSTALL.md)).
2. В PassDesk env заменяются две переменные: endpoint и API-ключ.
3. В `server/src/services/ocr/ocrService.js` добавляются два HTTP-заголовка: `X-Request-Id` и `X-Idempotency-Key`. Остальная логика OCR не меняется.

## Шаги

### 1. Получить токен прокси

Администратор VPS (где живёт `proxy_llm`) даёт значение `PROXY_INBOUND_TOKEN`. Это случайный 32-байт hex, сгенерированный при установке прокси.

### 2. Заменить переменные окружения PassDesk

В `.env` PassDesk-сервера (или там, где хранится конфигурация):

```env
# БЫЛО:
# OCR_OPENROUTER_ENDPOINT=https://openrouter.ai/api/v1/chat/completions
# OCR_API_KEY=sk-or-v1-<настоящий ключ OpenRouter>

# СТАЛО:
OCR_OPENROUTER_ENDPOINT=https://proxy.example.com/api/v1/chat/completions
OCR_API_KEY=<значение PROXY_INBOUND_TOKEN>
OCR_IDEMPOTENCY_VERSION=v1
```

После замены настоящего OpenRouter-ключа в PassDesk быть не должно. Удалить из всех .env, файлов CI, secret-стораджа.

`OCR_OPENROUTER_MODEL` и `OCR_FALLBACK_MODEL` можно оставить — прокси их игнорирует, но переменные читаются текущим `getOcrConfig()`.

### 3. Добавить два заголовка в исходящий axios-запрос

Файл `server/src/services/ocr/ocrService.js`. В местах сборки `headers` для `axios.post(config.endpoint, payload, …)` (в текущем коде это окрестности строк ~1818-1825 и ~2047-2054) добавить:

```js
const crypto = require('node:crypto');

// На каждой попытке — уникальный X-Request-Id
headers['X-Request-Id'] = crypto.randomUUID();

// На каждой OCR-задаче — СТАБИЛЬНЫЙ X-Idempotency-Key
const idempVer = process.env.OCR_IDEMPOTENCY_VERSION || 'v1';
const idempotencyInput = [
  fileId,                    // или employee_file_id
  documentType,              // если доступно
  promptVersion,             // если доступно
  idempVer,
].filter(Boolean).join(':');
headers['X-Idempotency-Key'] = crypto
  .createHash('sha256')
  .update(idempotencyInput)
  .digest('hex');
```

**Fallback-формула** (если `documentType` или `promptVersion` сложно прокинуть до места axios-вызова):

```js
const idempotencyInput = [
  employeeFileId,
  fileSha256OrStorageKey,
  promptNameOrHash,
  idempVer,
].join(':');
```

Главное требование к `X-Idempotency-Key`:
- ДОЛЖЕН совпадать между BullMQ-ретраями одной OCR-задачи;
- НЕ должен совпадать между разными задачами, файлами, промптами;
- при изменении промпта или схемы распознавания админ поднимает `OCR_IDEMPOTENCY_VERSION` (`v1` → `v2`) — старые ключи перестанут конфликтовать с новой логикой.

### 4. Перезапустить PassDesk-сервер

```bash
# на VPS PassDesk
pm2 reload passdesk     # или systemctl restart, как принято в PassDesk
```

### 5. Проверка

1. Загрузить тестовый скан паспорта через UI PassDesk.
2. В логах PassDesk — должен быть HTTP-запрос на `proxy.example.com`, НЕ на `openrouter.ai`.
3. В дашборде прокси (`https://proxy.example.com/dashboard`, под Basic Auth) — должна появиться новая запись с тем же `X-Request-Id`.
4. Искусственный retry: вернуть 503 от прокси (выключить → curl → включить), убедиться что PassDesk BullMQ повторяет с **тем же** `X-Idempotency-Key` и **новым** `X-Request-Id`.

## Что прокси игнорирует / перезаписывает в payload

Прокси централизованно контролирует:

- `model` / `models` — устанавливает свои из env `OPENROUTER_MODEL` (+ `OPENROUTER_FALLBACK_MODELS`).
- `stream` — принудительно `false`.
- `provider`, `route`, `transforms`, `plugins`, `stream_options`, `debug` — удаляются из payload (denylist).

Если PassDesk эти поля не передаёт — никаких изменений. Если передаёт — прокси молча уберёт. Это нужно, чтобы routing/провайдер-настройки нельзя было обойти со стороны клиента.

**Plugins:** PassDesk не управляет OpenRouter plugins. Если в будущем понадобится PDF/file-parser/web-search, включать только на стороне `proxy_llm` через его env, не из PassDesk-payload.

## Эксплуатация

- Алерты приходят в Telegram-чат, указанный в `TELEGRAM_ADMIN_CHAT_ID` прокси.
- Журнал — `https://proxy.example.com/dashboard` (Basic Auth, IP-allowlist на nginx).
- Биллинг-сверка: каждая запись в журнале содержит `upstream_id` = OpenRouter id (`gen-…`). По нему можно найти конкретный вызов в OpenRouter-биллинге.
- Ротация `PROXY_INBOUND_TOKEN` — раз в 3-6 месяцев, согласованный рестарт прокси и PassDesk.
- Ротация `OPENROUTER_API_KEY` — только на прокси, PassDesk не трогаем.

## Rollback

См. два сценария в [deploy/INSTALL.md](../deploy/INSTALL.md): preferred (чинить прокси, не трогать PassDesk) и emergency (вернуть прямой `openrouter.ai` URL и ключ в PassDesk — только при P0 + обязательный чек-лист возврата к secure-состоянию + ротация ключа OpenRouter).

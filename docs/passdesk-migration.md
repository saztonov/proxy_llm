# Миграция PassDesk на proxy_llm

Этот документ описывает шаги переключения OCR-функции PassDesk с прямых вызовов `openrouter.ai` на прокси-сервис `proxy_llm`. Цель — полностью убрать ключ OpenRouter из PassDesk env и получить централизованный журнал/алерты.

## Кратко

1. На VPS поднят `proxy_llm` ([deploy/INSTALL.md](../deploy/INSTALL.md)).
2. В PassDesk env заменяются две переменные: endpoint и API-ключ.
3. В `server/src/services/ocr/ocrService.js` добавляются два HTTP-заголовка: `X-Request-Id` и `X-Idempotency-Key`. Остальная логика OCR не меняется.

## Шаги

### 1. Получить токен прокси

Администратор VPS (где живёт `proxy_llm`) даёт токен клиента `passdesk` — случайный 32-байт hex из реестра `/etc/proxy_llm/clients.json`. Если реестр ещё не включён (single-tenant legacy), это значение `PROXY_INBOUND_TOKEN` из `.env` прокси: оно всегда резолвится в клиента `passdesk`.

Заодно спросить у оператора **политику моделей** для `passdesk`: дефолтную модель и `allowedModels` (пусто = выбор запрещён / список / `*`). От этого зависит судьба `OCR_OPENROUTER_MODEL` — см. шаг 2.

### 2. Заменить переменные окружения PassDesk

В `.env` PassDesk-сервера (или там, где хранится конфигурация):

```env
# БЫЛО:
# OCR_OPENROUTER_ENDPOINT=https://openrouter.ai/api/v1/chat/completions
# OCR_API_KEY=sk-or-v1-<настоящий ключ OpenRouter>

# СТАЛО:
OCR_OPENROUTER_ENDPOINT=https://proxy.example.com/api/v1/chat/completions
OCR_API_KEY=<токен клиента passdesk>
OCR_IDEMPOTENCY_VERSION=v1
```

После замены настоящего OpenRouter-ключа в PassDesk быть не должно. Удалить из всех .env, файлов CI, secret-стораджа.

`OCR_OPENROUTER_MODEL` и `OCR_FALLBACK_MODEL` формально можно оставить — их читает `getOcrConfig()`.

⚠️ Но **`OCR_OPENROUTER_MODEL` уходит в прокси в поле `model` payload'а.** Сегодня прокси его игнорирует (у клиента `passdesk` пустой `allowedModels`), и это **не гарантия, а настройка**: как только оператор разрешит `passdesk` выбор модели (его `allowedModels` или глобальный `CLIENT_DEFAULT_ALLOWED_MODELS=*`), значение из env PassDesk **оживёт и молча**:

- уведёт роутинг и биллинг на модель из env PassDesk, а не на `defaultModel` из `clients.json`;
- **отключит fallback-цепочку** — явный выбор уходит одиночным `model`, без `models[]`: при недоступности провайдера будет ошибка вместо переезда на резервную модель.

Два пути, выбрать один:

1. **Остаться на модели прокси (рекомендуется, если выбор не нужен):** `OCR_OPENROUTER_MODEL=proxy`. Заглушки `proxy`/`default`/`auto` означают «модель не выбираю» → дефолт клиента + fallback. Тогда включение выбора на прокси PassDesk уже не заденет.
2. **Выбирать модель осознанно:** оставить реальный слаг, но помнить, что fallback отключится, и обрабатывать `400 model_not_allowed`. Рецепт — §8 скилла `.claude/skills/connect-proxy-llm/`.

Пока не сделано ни то, ни другое, PassDesk держится на том, что выбор модели ему не включили. Оператору — чек-лист `docs/vps-update.md` §4a.

`OCR_FALLBACK_MODEL` прокси не использует вообще: fallback-цепочка задаётся на прокси (`fallbackModels`), клиентский `models[]` вырезается.

### 3. Добавить два заголовка в исходящий axios-запрос

⚠️ **Мест вызова НЕСКОЛЬКО, и правка нужна в каждом.** Это уже один раз сделали наполовину: по журналу прокси за 2026-07-16 из 59 боевых запросов PassDesk **58 ушли без `X-Idempotency-Key`** (средний размер тела 505 КБ — настоящие сканы). Заголовок добавили в одно место, второе — то, по которому идёт основной OCR, — осталось без него. Итог: дедуп не включался ни разу, и каждый ретрай BullMQ оплачивался как новый вызов OpenRouter.

Поэтому: сначала найти **все** места вызова, потом править, потом проверить фактом (шаг 5), а не глазами по коду.

```bash
grep -rn "config.endpoint\|OCR_OPENROUTER_ENDPOINT\|chat/completions" server/src/ --include='*.js'
```

Файл `server/src/services/ocr/ocrService.js`. В **каждом** месте сборки `headers` для `axios.post(config.endpoint, payload, …)` (в текущем коде это окрестности строк ~1818-1825 и ~2047-2054) добавить:

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
- отправляется из КАЖДОГО места вызова прокси, а не только из основного;
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
5. **Прогнать OCR по всем типам документов и сценариям**, какие есть в UI (паспорт, прочие типы, батч, повтор упавшей задачи) — чтобы задействовать каждое место вызова из шага 3, а не только основное.
6. **Обязательно — проверка фактом на прокси.** Единственный способ поймать недоработанное место вызова: клиент своего трафика в журнале не видит. На VPS прокси через сутки после запуска:

   ```bash
   sqlite3 -header -column /var/lib/proxy_llm/prod.db \
     "select case when idempotency_key is null or idempotency_key='' then 'БЕЗ ключа' else 'с ключом' end k,
             count(*), round(avg(request_bytes)/1024.0) avg_kb
      from requests where client_id='passdesk' group by 1;"
   ```

   Строка «БЕЗ ключа» обязана отсутствовать. Есть, да ещё со средним размером в сотни КБ, — значит какое-то место вызова пропущено, и именно оно несёт боевые сканы. Миграция не считается завершённой, пока эта строка не исчезнет.

## Что прокси вырезает и как решает про модель

Прокси централизованно контролирует:

- `models` — **всегда** вырезается: свою fallback-цепочку прислать нельзя, её задаёт оператор (`fallbackModels`).
- `model` — **не удаляется**, а резолвится по политике клиента `passdesk` в `clients.json`: при пустом `allowedModels` игнорируется и форсится `defaultModel` (+ fallback-цепочка); при непустом — уходит в роутинг как есть, и fallback отключается. Заглушки `proxy`/`default`/`auto` = «модель не выбираю» → `defaultModel`. См. предупреждение про `OCR_OPENROUTER_MODEL` выше.
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

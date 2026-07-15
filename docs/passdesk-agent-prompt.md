# Промт для агента: миграция PassDesk на proxy_llm

Этот файл — самодостаточный промт для LLM-агента (Claude Code / Cursor / Cline), которому поручают внести минимальные изменения в PassDesk для перехода на прокси `proxy_llm`. Скопируйте всё содержимое ниже (от строки `# Задача` до конца) в виде первого сообщения агенту.

---

# Задача: переключить PassDesk на прокси-сервис proxy_llm

## Контекст
PassDesk сейчас ходит в OpenRouter напрямую из `server/src/services/ocr/ocrService.js`
(см. функцию вокруг `axios.post(config.endpoint, payload, …)` на ~строке 1668 и
`getOcrConfig()` на ~строке 1473). Мы выносим вызовы LLM на отдельный VPS-сервис
`proxy_llm`, чтобы изолировать ключ OpenRouter и получить централизованный журнал.

Прокси предоставляет OpenAI-совместимый endpoint:
  POST https://proxy.example.com/api/v1/chat/completions
с авторизацией Bearer <PROXY_INBOUND_TOKEN>.

## Жёсткие требования
1. PassDesk БОЛЬШЕ НЕ должен ходить в openrouter.ai напрямую ни в одном
   сценарии (включая retry, fallback-цепочку моделей, тестовые запросы).
2. Ключ OpenRouter ДОЛЖЕН быть удалён из env PassDesk полностью.
3. Изменения должны быть минимально-инвазивны: только в ocrService.js и в README.
4. Изменение не должно сломать существующую BullMQ-очередь и её retry-механизм.
5. Endpoint в env остаётся той же переменной OCR_OPENROUTER_ENDPOINT — меняем
   только значение, не имя переменной.

## Что сделать
1. В `server/src/services/ocr/ocrService.js`:
   а) Найти места, где собираются HTTP-headers для axios.post в OpenRouter.
      В текущем коде это окрестности строк ~1818-1825 и ~2047-2054 — там,
      где собирается объект `headers` с Authorization/HTTP-Referer/X-Title.
   б) Добавить два заголовка:
      - `X-Request-Id`: уникальный для каждой HTTP-попытки. Использовать
        `crypto.randomUUID()` из встроенного модуля `node:crypto`.
      - `X-Idempotency-Key`: стабильный для одной OCR-задачи.
        **Целевая формула**: sha256 от
        `${file_id}:${document_type}:${prompt_version}:${idempVer}`,
        где `idempVer = process.env.OCR_IDEMPOTENCY_VERSION || 'v1'`.
        **Fallback-формула** (если document_type/prompt_version не лежат
        рядом с axios-вызовом и их трудно прокинуть): sha256 от
        `${employee_file_id}:${file_sha256_or_storage_key}:${prompt_name_or_hash}:${idempVer}`.
        Главное — этот ключ ДОЛЖЕН совпадать между ретраями одной BullMQ-задачи
        и НЕ совпадать между разными задачами. При изменении промпта или схемы
        распознавания админ поднимает OCR_IDEMPOTENCY_VERSION в env (v1 → v2),
        чтобы старые ключи не конфликтовали с новой логикой.
   в) Эти заголовки добавляются в дополнение к существующим:
      Authorization, HTTP-Referer, X-Title. **Прокси игнорирует входящие
      HTTP-Referer и X-Title — он подставляет свои значения в OpenRouter.**
      Поэтому в PassDesk их можно оставить как есть (для обратной совместимости
      на случай возврата к прямым OpenRouter-вызовам).
   г) Не менять структуру payload (`messages`, `model`, и т.п.). Прокси УДАЛИТ из
      payload следующие поля, если они там есть: `models`, `provider`, `route`,
      `transforms`, `plugins`, `stream`, `stream_options`, `debug`. Если
      PassDesk эти поля не передаёт — ничего не изменится. Если передаёт —
      прокси молча уберёт. Этот denylist нужен, чтобы routing/провайдер-настройки
      контролировались централизованно на прокси.
      **Важно про `model`:** это поле прокси НЕ удаляет. Оно резолвится по политике
      клиента `passdesk`: сейчас у него выбор модели выключен, поэтому значение
      игнорируется и форсится модель прокси — но если оператор выбор включит,
      значение уедет в роутинг как есть и отключит fallback-цепочку прокси.
      Поэтому значение `model` в payload должно быть осмысленным: либо заглушка
      `proxy` («модель выбирает прокси»), либо реально желаемая модель.

2. В README или в `docs/ocr.md` PassDesk:
   - Кратко описать, что OCR идёт через прокси `proxy_llm`.
   - Указать env-переменные, которые нужно настроить:
     * OCR_OPENROUTER_ENDPOINT=https://proxy.example.com/api/v1/chat/completions
     * OCR_API_KEY=<токен клиента passdesk> (НЕ openrouter-ключ)
     * OCR_IDEMPOTENCY_VERSION=v1   # поднимать до v2 при изменении промпта/схемы распознавания
     * OCR_OPENROUTER_MODEL=proxy   # заглушка: модель выбирает прокси
   - Указать, что OCR_FALLBACK_MODEL прокси не использует вообще — fallback-цепочка
     задаётся на стороне прокси (`fallbackModels`), клиентский `models[]` вырезается.
   - Указать, что OCR_OPENROUTER_MODEL уходит в поле `model` запроса: сейчас прокси
     его игнорирует (выбор модели для passdesk выключен), но при включении выбора
     значение оживёт и изменит роутинг и биллинг. Безопасное значение —
     `OCR_OPENROUTER_MODEL=proxy` (заглушка «модель выбирает прокси»).
   - Указать, что поля payload `provider`, `route`, `transforms`, `plugins`,
     `stream`, `stream_options`, `debug` если попадут в payload — будут молча
     удалены прокси (этот denylist реализован централизованно).

3. Тесты (если есть юнит-тесты на ocrService):
   - Адаптировать моки, чтобы проверять наличие X-Request-Id и
     X-Idempotency-Key в заголовках исходящего axios-запроса.
   - Тест: два повтора одной OCR-задачи генерят одинаковый X-Idempotency-Key,
     но разные X-Request-Id.

## Что НЕ делать
- НЕ удалять и не переименовывать OCR_OPENROUTER_ENDPOINT / OCR_API_KEY /
  OCR_OPENROUTER_MODEL — только меняем значения, имена остаются для
  совместимости с существующей логикой `getOcrConfig()`. Значение
  OCR_OPENROUTER_MODEL рекомендуется поменять на `proxy` (см. выше).
- НЕ менять формат payload — прокси принимает OpenAI-совместимый запрос
  как есть.
- НЕ добавлять никакой собственной логики retry в ocrService — BullMQ уже
  ретраит на уровне очереди, прокси ретраит внутри upstream-вызова.
- НЕ хранить PROXY_INBOUND_TOKEN в коде, только в env.

## Verification
1. `git diff` показывает изменения только в ocrService.js и в одном файле
   документации.
2. `npm run lint` и существующие тесты проходят.
3. Загрузка тестового скана паспорта через UI приводит к успешному
   распознаванию (end-to-end).
4. В логах PassDesk видно, что запрос ушёл на адрес прокси, а не на
   openrouter.ai.
5. В дашборде прокси (https://proxy.example.com/dashboard) появилась
   запись с тем же X-Request-Id, что в логах PassDesk.
6. Повторный retry той же OCR-задачи (искусственно: вернуть 503 от прокси)
   приводит к новому X-Request-Id, но тому же X-Idempotency-Key.

## Rollback
Если что-то пошло не так — вернуть в env:
  OCR_OPENROUTER_ENDPOINT=https://openrouter.ai/api/v1/chat/completions
  OCR_API_KEY=<настоящий openrouter-ключ>
И перезапустить PassDesk-сервер. Код менять не нужно — добавленные заголовки
X-Request-Id и X-Idempotency-Key OpenRouter просто проигнорирует.

⚠️ Это emergency-rollback. После устранения проблемы с прокси:
1. Восстановить прокси.
2. Вернуть env PassDesk на URL прокси и PROXY_INBOUND_TOKEN.
3. Удалить настоящий OpenRouter-ключ из PassDesk env.
4. Ротировать OpenRouter API key на стороне OpenRouter — раз ключ временно
   лежал в PassDesk, его компрометация считается возможной.

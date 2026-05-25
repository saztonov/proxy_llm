# Глоссарий алертов proxy_llm

Каждый алерт прокси шлёт в Telegram-чат `TELEGRAM_ADMIN_CHAT_ID`.

| Алерт | Триггер | Cooldown | Что делать |
|---|---|---|---|
| 🔄 **proxy_llm запущен** | старт процесса | нет | Сравнить uptime в сообщении с ожидаемым (60s после restart vs неожиданно мало = crash). |
| 🚨 **OpenRouter 401** | HTTP 401 от OpenRouter | нет | Проверить `OPENROUTER_API_KEY`, при компрометации — ротировать. См. [runbook.md](runbook.md#ротация-openrouter_api_key). |
| 🚨 **OpenRouter 402** | HTTP 402 от OpenRouter | нет | Закончились кредиты. Пополнить баланс. |
| ⚠️ **Серия ошибок** | ≥5 ошибок подряд | 10 мин | Смотреть `journalctl -u proxy_llm -n 200` и `/dashboard`. |
| 📉 **Высокий error rate** | >30% за последние 50 запросов (min 20) | 30 мин | Деградация OpenRouter или сетевая проблема. |
| 📡 **OpenRouter недоступен** | DNS/TCP-ошибка ≥3 подряд | 5 мин | Проверить `dig openrouter.ai`, `curl -v https://openrouter.ai/`. |
| 🐢 **Долгий запрос** | latency > ALERT_LONG_REQUEST_MS (default 150s) | per-request | Один конкретный запрос. Watchdog должен abort'ить. |
| 🔥 **Зависший запрос** | watchdog нашёл активный > deadline+30s | per-request | Принудительный abort. Изучить причину (баг). |
| 💾 **Мало места на диске** | < ALERT_DISK_FREE_MIN_BYTES (default 500 МБ) | 24 ч | См. [runbook.md](runbook.md#мало-места-на-диске). |
| ✅ **Восстановление** | первый успех после серии ошибок | нет | Информационный — никаких действий. |
| 📊 **Дневная сводка** | 09:00 МСК | нет | Информационный — суммарные метрики за 24 часа. |

## Что в каждом сообщении

- Время — берётся из заголовка Telegram-сообщения.
- Кратко описание проблемы.
- Иногда — request_id или latency.

## Что НЕ кладётся в Telegram

- Тела запросов и ответов.
- Токены `OPENROUTER_API_KEY` и `PROXY_INBOUND_TOKEN`.
- PII (сканы паспортов, распознанные данные).

Все секреты обрезаются через `pino-redact` ещё до того, как попасть в alert engine. Если в Telegram-сообщении вдруг появится строка, похожая на ключ — это инцидент, ротировать ключ и проверить `src/utils/sanitize.ts`.

## Настройка порогов

В `/etc/proxy_llm/.env`:

```env
ALERT_ERROR_STREAK_THRESHOLD=5      # серия ошибок
ALERT_ERROR_RATE_THRESHOLD=0.30     # 30% error rate
ALERT_ERROR_RATE_WINDOW=50          # окно для error rate
ALERT_LONG_REQUEST_MS=150000        # долгий запрос
ALERT_DISK_FREE_MIN_BYTES=524288000 # 500 МБ
```

После изменения — `systemctl restart proxy_llm`.

## Отключение всех алертов

Если нужно временно молча:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_CHAT_ID=
```

Прокси продолжит писать в лог "telegram alert skipped: not configured", но HTTP не вызовет.

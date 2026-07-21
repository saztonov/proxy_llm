# Runbook — типовые операции с proxy_llm

## Где смотреть, когда что-то сломалось

1. Telegram-канал (если настроен) — первые алерты.
2. `journalctl -u proxy_llm -f` — runtime-логи прокси.
3. `https://proxy.example.com/dashboard` (Basic Auth) — журнал последних 100 запросов, агрегаты, p95.
4. `journalctl -u nginx -f` — если 502 от nginx до того, как пришёл прокси.
5. `https://proxy.example.com/healthz` — публичный liveness (только `{"status":"ok"}`).
6. `curl -sS http://127.0.0.1:3000/readyz` (на VPS) — readiness (DB + DNS до OpenRouter).

## Ротация секретов

### Ротация PROXY_INBOUND_TOKEN

Раз в 3-6 месяцев или при компрометации. Согласованная операция между proxy_llm и PassDesk.

```bash
# [ROOT на proxy_llm VPS]
NEW=$(openssl rand -hex 32)
echo "$NEW"   # передать админу PassDesk через защищённый канал

# Подменить в /etc/proxy_llm/.env:
sed -i "s|^PROXY_INBOUND_TOKEN=.*|PROXY_INBOUND_TOKEN=${NEW}|" /etc/proxy_llm/.env

# [ADMIN PassDesk] — подменить OCR_API_KEY на новое значение, перезапустить PassDesk

# [ROOT на proxy_llm VPS]
systemctl restart proxy_llm
journalctl -u proxy_llm -f --since '1 minute ago'

# Сделать тестовый OCR-запрос в PassDesk, убедиться что 200
```

### Ротация OPENROUTER_API_KEY

Только на стороне прокси, PassDesk не трогаем.

```bash
# [ROOT на proxy_llm VPS]
# 1. На openrouter.ai создать новый ключ.
# 2. Подставить в /etc/proxy_llm/.env:
nano /etc/proxy_llm/.env
# OPENROUTER_API_KEY=sk-or-v1-<новый ключ>

systemctl restart proxy_llm
journalctl -u proxy_llm -f --since '1 minute ago'

# 3. После проверки — удалить старый ключ на openrouter.ai.
```

## Восстановление SQLite из бэкапа

```bash
# [ROOT]
ls -lh /var/lib/proxy_llm/backups/   # выбрать нужный prod.db.YYYYMMDDTHHMMSSZ.gz

systemctl stop proxy_llm
cp /var/lib/proxy_llm/prod.db /var/lib/proxy_llm/prod.db.before-restore
gunzip -c /var/lib/proxy_llm/backups/prod.db.<date>.gz > /var/lib/proxy_llm/prod.db
chown proxy_llm:proxy_llm /var/lib/proxy_llm/prod.db
systemctl start proxy_llm
```

## Перезапуск без потери активных запросов

```bash
# [ROOT]
systemctl restart proxy_llm
# Прокси словит SIGTERM, перестанет принимать новые соединения,
# ждёт активные до GRACEFUL_DRAIN_MS (default 60s), потом exit.
```

При штатном `restart` в Telegram придёт алерт "Прокси перезапущен" — это нормально.

## Что делать при алерте

### "OpenRouter 401"

Ключ невалиден или отозван. Срочно:
1. Проверить `OPENROUTER_API_KEY` в `/etc/proxy_llm/.env`.
2. Зайти на openrouter.ai, проверить статус ключа.
3. Если ключ компрометирован — ротировать (см. выше).

### "OpenRouter 402"

Закончились кредиты. Пополнить баланс на openrouter.ai. Никаких изменений в прокси не нужно — после пополнения PassDesk BullMQ повторит зависшие задачи.

### "Серия ошибок ≥5 подряд"

Смотреть `journalctl -u proxy_llm -n 200` и `/dashboard`:
- Если все 5xx от OpenRouter — это их деградация, ждать.
- Если все network errors — проверить DNS/TCP до openrouter.ai с VPS.
- Если все `body_level_error` с одинаковым `error_code` — конкретная проблема (moderation policy, изменения API).

### "Высокий error rate >30%"

Проверить `/dashboard`. Если стабильно высокий — деградация OpenRouter или сетевая проблема. Если периодические всплески — возможно регресс в новой версии модели.

### "OpenRouter недоступен"

DNS/TCP проблема с VPS до openrouter.ai. Проверить:
```bash
dig openrouter.ai
curl -v https://openrouter.ai/
```

### "Долгий запрос >150s"

Один конкретный запрос завис. Watchdog должен был его abort'ить. Если такие алерты идут пачкой — проверить размер payload (PassDesk может посылать слишком большие сканы).

### "Stuck request"

Watchdog нашёл активный запрос, который пережил `deadline + 30s` без abort'а. Принудительно abort'нул. В нормальной работе такого быть не должно — изучить причину (баг в коде, ошибка undici).

### "Мало места на диске"

```bash
# [ROOT]
df -h /var/lib/proxy_llm/
du -sh /var/lib/proxy_llm/*
# Чаще всего разрастается WAL — принудительный checkpoint:
sudo -u proxy_llm /opt/proxy_llm/scripts/wal-checkpoint.sh
# Если виноваты бэкапы — уменьшить RETENTION_DAYS в scripts/backup-db.sh
```

## Сообщения сверки admission-слотов

В журнале бывают два разных сообщения, и путать их нельзя.

**`fairness admission leak corrected`** (`warn`) — найдена и снята настоящая утечка слотов:
счётчик держал превышение над реальным числом живых запросов все 4 тика подряд (2 минуты).
Это тот самый класс сбоя, из-за которого `estimat` двое суток получал `queue_full`
(инцидент 2026-07-17). Сервис вылечился сам, restart не нужен. Поле `leakedSlots` — сколько
слотов снято, `samples` — окно наблюдений. Если сообщение повторяется регулярно, значит
`release()` систематически не долетает: смотреть, не обрывают ли клиенты соединение на
отдаче ответа (`onResponse`/`onRequestAbort` в такой ситуации могут не сработать оба).

**`fairness drift transient, not corrected`** (`debug`, в проде не виден) — расхождение
было, но исчезло на следующем тике. Это НЕ утечка. Слот выдаётся в `onRequest`-хуке, до
чтения тела, а в `ActiveMetrics` запрос попадает уже внутри обработчика, после парсинга.
Для тел на сотни килобайт окно порядка секунд, и тик, попавший в него, видит расхождение
у совершенно здорового запроса.

До 2026-07-21 сверка корректировала расхождение мгновенно и поэтому обнуляла слот живого
запроса — то есть молча снимала лимит конкурентности вместо того, чтобы чинить утечку. За
30 часов наблюдений все три срабатывания оказались именно такими ложными (тела 155–483 КБ,
обработка ~2.1 с, тик приходился ровно на окно парсинга). Теперь корректируется только
минимальное превышение за окно: настоящая утечка держится вечно и даёт положительный
минимум даже под нагрузкой, а окно парсинга роняет минимум в ноль.

## Биллинг-сверка с OpenRouter

Каждая запись в журнале содержит `upstream_id` (OpenRouter `gen-…`). По нему можно найти конкретный вызов в OpenRouter dashboard и сверить usage/cost.

```bash
# Найти все запросы за последний день с tokens > N:
sqlite3 /var/lib/proxy_llm/prod.db \
  "SELECT upstream_id, model_used, total_tokens, ts_received FROM requests
   WHERE ts_received > strftime('%s','now','-1 day')*1000
     AND total_tokens > 5000
   ORDER BY total_tokens DESC LIMIT 20;"
```

## Включение жёсткого systemd hardening (Iteration 2)

ВАЖНО: НЕ включать `MemoryDenyWriteExecute=true` — ломает V8 JIT.

После smoke-теста можно попробовать (по одному, с перезапуском и проверкой логов):

```ini
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
RestrictNamespaces=true
ProtectClock=true
ProtectHostname=true
ProtectKernelLogs=true
```

Если в `journalctl -u proxy_llm` появятся ошибки вида "syscall blocked" или "permission denied" — откатить именно тот фильтр и зафиксировать в этом файле.

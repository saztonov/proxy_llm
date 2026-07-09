# proxy_llm — руководство админа

Документ для админа, который разворачивает прокси с нуля на VPS, передаёт токен в PassDesk, и потом эксплуатирует систему. Все команды копи-пастные. Перед каждой командой стоит метка пользователя, от которого её выполнять.

**Условные обозначения:**
- `[ROOT]` — выполнять от `root` (через `sudo -i` или с префиксом `sudo`)
- `[PROXY_LLM]` — от системного пользователя `proxy_llm` (`sudo -u proxy_llm ...`)
- `[ADMIN-LOCAL]` — с локальной машины админа (Windows/Mac/Linux)
- `[ADMIN-PASSDESK]` — на VPS, где живёт PassDesk

**Placeholder'ы, которые надо заменить на свои:**
- `proxy.example.com` — реальный домен прокси
- `1.2.3.4` — реальный IP VPS PassDesk
- `5.6.7.8` — реальный IP админа (с которого смотреть dashboard)
- `admin@example.com` — email админа (для certbot)
- `passdesk.your-domain.example` — реальный URL PassDesk (для атрибуции в OpenRouter)

---

## Часть 1. Что должно быть готово ДО начала

### 1.1. VPS

- Ubuntu 22.04 или 24.04 LTS, как минимум 2 vCPU и 2 ГБ RAM (рекомендуется 4 ГБ при нагрузке 240 req/сутки с payload до 16 МБ).
- На VPS уже установлен и работает `nginx`.
- Открыты порты 80 (для ACME challenge) и 443 (для HTTPS).
- Корневой доступ (`sudo`).

### 1.2. DNS

A-запись `proxy.example.com` → IP вашего VPS. Проверка:

```bash
# [ADMIN-LOCAL]
dig +short proxy.example.com
# должен вернуть IP VPS
```

### 1.3. Известны параметры окружения

Подготовьте заранее:

| Параметр | Значение | Где взять |
|---|---|---|
| Настоящий OpenRouter API key | `sk-or-v1-…` | dashboard OpenRouter → Keys |
| IP-адрес VPS PassDesk | например `1.2.3.4` | у админа PassDesk |
| IP-адрес админа (для dashboard) | например `5.6.7.8` | свой публичный IP, см. `curl ifconfig.me` |
| Telegram Bot Token (опционально) | `123:ABC...` | BotFather |
| Telegram Chat ID для алертов | число | у бота `getUpdates` |
| Email для certbot | `admin@example.com` | свой |

---

## Часть 2. Развёртывание (пошагово)

### Шаг 2.0. Предполётные проверки

```bash
# [ROOT]
node --version            # если v22.x — ок; если другое — см. шаг 2.1
ss -tlnp | grep ':3000'   # порт должен быть свободен; если занят — выбрать другой
nginx -t                  # nginx должен быть установлен и конфиг валиден
```

### Шаг 2.1. Установка Node.js 22 LTS

**Если на VPS нет других Node-сервисов** — самый простой вариант, ставим системно:

```bash
# [ROOT]
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version            # должно быть v22.x
which node                # /usr/bin/node
```

Если на VPS уже стоит другая Node для соседей — поставить через tarball в `/opt/node-v22/` (см. [deploy/INSTALL.md](../deploy/INSTALL.md), Вариант B). В этом случае ниже в systemd-юните придётся заменить путь к node.

### Шаг 2.2. Создание пользователя и каталогов

```bash
# [ROOT]
adduser --system --group --no-create-home --shell /usr/sbin/nologin proxy_llm
id proxy_llm

mkdir -p /opt/proxy_llm
mkdir -p /etc/proxy_llm
mkdir -p /var/lib/proxy_llm/backups

chown -R root:root           /opt/proxy_llm     && chmod 755 /opt/proxy_llm
chown -R root:proxy_llm      /etc/proxy_llm     && chmod 750 /etc/proxy_llm
chown -R proxy_llm:proxy_llm /var/lib/proxy_llm && chmod 700 /var/lib/proxy_llm

ls -ld /opt/proxy_llm /etc/proxy_llm /var/lib/proxy_llm
```

Ожидаемый вывод последней команды (примерно):

```
drwxr-xr-x  /opt/proxy_llm           root      root
drwxr-x---  /etc/proxy_llm           root      proxy_llm
drwx------  /var/lib/proxy_llm       proxy_llm proxy_llm
```

### Шаг 2.3. Размещение кода и сборка

Вариант A — клонирование из git (рекомендуется для MVP):

```bash
# [ROOT]
apt-get install -y git
cd /opt
git clone <repo-url-вашего-репозитория> proxy_llm-src
mv proxy_llm-src/* /opt/proxy_llm/
mv proxy_llm-src/.gitignore /opt/proxy_llm/ 2>/dev/null || true
rm -rf proxy_llm-src

cd /opt/proxy_llm
npm ci                    # ставит И devDeps (нужен TypeScript)
npm run build             # tsc → dist/
npm prune --omit=dev      # убираем devDeps после сборки

ls -la dist/server.js     # должен существовать

chown -R root:root /opt/proxy_llm
chmod -R go-w /opt/proxy_llm
```

Вариант B — деплой собранного артефакта из CI. См. [deploy/INSTALL.md](../deploy/INSTALL.md), шаг 3.

### Шаг 2.4. Создание `.env` (с генерацией секретов)

Это **самый важный шаг**. Здесь же генерируем токен, который потом передадим в PassDesk.

```bash
# [ROOT]

# 1. Сгенерировать секреты
PROXY_INBOUND_TOKEN=$(openssl rand -hex 32)
DASHBOARD_PASS=$(openssl rand -base64 24)

# 2. Скопировать шаблон
cp /opt/proxy_llm/.env.example /etc/proxy_llm/.env

# 3. Подставить сгенерированные значения
sed -i "s|^PROXY_INBOUND_TOKEN=.*|PROXY_INBOUND_TOKEN=${PROXY_INBOUND_TOKEN}|" /etc/proxy_llm/.env
sed -i "s|^DASHBOARD_BASIC_AUTH_PASS=.*|DASHBOARD_BASIC_AUTH_PASS=${DASHBOARD_PASS}|" /etc/proxy_llm/.env

# 4. Открыть в редакторе и доподставить руками остальное
nano /etc/proxy_llm/.env
```

В редакторе обязательно подставить:

```env
OPENROUTER_API_KEY=sk-or-v1-<ваш настоящий ключ OpenRouter>
OPENROUTER_HTTP_REFERER=https://passdesk.your-domain.example
DB_PATH=/var/lib/proxy_llm/prod.db
TELEGRAM_BOT_TOKEN=<если используется>
TELEGRAM_ADMIN_CHAT_ID=<если используется>
```

Остальные параметры можно оставить дефолтными — см. комментарии в `.env.example`.

После сохранения — фиксируем права:

```bash
# [ROOT]
chown root:proxy_llm /etc/proxy_llm/.env
chmod 640 /etc/proxy_llm/.env
ls -l /etc/proxy_llm/.env
# должно быть: -rw-r----- root proxy_llm
```

**Запишите токены в защищённое хранилище (1Password / Vaultwarden / Bitwarden):**

```bash
# Распечатать оба токена, скопировать в менеджер паролей
echo "=== СОХРАНИТЬ В ПАРОЛЬНЫЙ МЕНЕДЖЕР ==="
echo "PROXY_INBOUND_TOKEN=$PROXY_INBOUND_TOKEN"
echo "DASHBOARD_PASS=$DASHBOARD_PASS"
echo "===================================="
```

Закройте терминал-сессию (или `unset PROXY_INBOUND_TOKEN DASHBOARD_PASS`), чтобы токены не висели в `~/.bash_history`.

`PROXY_INBOUND_TOKEN` — это то, что вы передадите админу PassDesk. См. **Часть 3** ниже.

### Шаг 2.5. systemd unit

```bash
# [ROOT]
cp /opt/proxy_llm/deploy/systemd/proxy_llm.service /etc/systemd/system/proxy_llm.service

# Если Node стоит не в /usr/bin/node (например tarball в /opt/node-v22/) —
# заменить ExecStart в файле:
nano /etc/systemd/system/proxy_llm.service
# ExecStart=/opt/node-v22/bin/node dist/server.js

systemctl daemon-reload
systemctl enable proxy_llm
# ВАЖНО: пока НЕ стартуем — сначала nginx и сертификат.
```

### Шаг 2.6. nginx — временный HTTP-only vhost для ACME

Финальный vhost ссылается на TLS-сертификат, которого ещё не существует. `nginx -t` упадёт. Поэтому сначала кладём временный HTTP-only.

```bash
# [ROOT]
cat > /etc/nginx/sites-available/proxy_llm.conf <<'EOF'
# Временный HTTP-only vhost для ACME challenge.
# Будет заменён на финальный после выпуска сертификата.
server {
    listen 80;
    server_name proxy.example.com;       # ← подставить ваш домен

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    location / {
        return 404;
    }
}
EOF

mkdir -p /var/www/html
ln -sf /etc/nginx/sites-available/proxy_llm.conf /etc/nginx/sites-enabled/proxy_llm.conf
nginx -t && systemctl reload nginx
```

Проверка, что ACME-путь работает (с локальной машины):

```bash
# [ADMIN-LOCAL]
curl -v http://proxy.example.com/.well-known/acme-challenge/test
# должно вернуть 404 (это нормально — файла нет, но ACME-путь обрабатывается)
```

### Шаг 2.7. Выпуск TLS-сертификата и установка финального vhost

```bash
# [ROOT]
apt-get install -y certbot python3-certbot-nginx

# Выпускаем сертификат. certbot сам добавит ssl-блоки в наш vhost.
certbot --nginx -d proxy.example.com \
  --non-interactive --agree-tos -m admin@example.com

# Теперь заменяем временный vhost на финальный из репозитория
cp /etc/nginx/sites-available/proxy_llm.conf /etc/nginx/sites-available/proxy_llm.conf.bak
cp /opt/proxy_llm/deploy/nginx/proxy_llm.conf /etc/nginx/sites-available/proxy_llm.conf

# Открыть и подставить:
nano /etc/nginx/sites-available/proxy_llm.conf
#   server_name proxy.example.com;     ← ваш домен (в двух местах)
#   allow 1.2.3.4;   в location /api/  ← IP PassDesk VPS
#   allow 5.6.7.8;   в location /dashboard ← IP админа
#   ssl_certificate     /etc/letsencrypt/live/proxy.example.com/fullchain.pem;
#   ssl_certificate_key /etc/letsencrypt/live/proxy.example.com/privkey.pem;
# (пути сертификатов certbot уже создал — просто подставить правильный домен)

nginx -t && systemctl reload nginx

# Проверка автообновления certbot:
systemctl status certbot.timer
```

### Шаг 2.8. Старт сервиса

```bash
# [ROOT]
systemctl start proxy_llm
systemctl status proxy_llm

# Смотрим логи запуска
journalctl -u proxy_llm -f --since '1 minute ago'
# Ожидаем строку: "proxy_llm started"
# (Ctrl+C чтобы выйти из follow-режима)

# Smoke-test изнутри VPS (минуя nginx):
curl -sS http://127.0.0.1:3000/healthz
# {"status":"ok"}

# Readiness (только локально):
curl -sS http://127.0.0.1:3000/readyz
# {"ready":true,"checks":{"db":"ok","dns":"ok"}}

# Через nginx (с whitelisted IP):
curl -sS https://proxy.example.com/healthz
# {"status":"ok"}
```

Если что-то не запустилось — смотрим `journalctl -u proxy_llm -n 100 --no-pager` и сравниваем с разделом **«Часто встречающиеся ошибки запуска»** в конце документа.

### Шаг 2.9. Cron — бэкап, WAL checkpoint, ротация

```bash
# [ROOT]
crontab -u proxy_llm -e
# В открывшемся редакторе добавить:
0 3 * * * /opt/proxy_llm/scripts/backup-db.sh
30 3 * * 0 /opt/proxy_llm/scripts/wal-checkpoint.sh
0 4 * * 0 /opt/proxy_llm/scripts/rotate-logs.sh

# Сохранить. Проверка:
crontab -u proxy_llm -l
```

### Шаг 2.10. Опционально: внешний UptimeRobot

В UptimeRobot создать HTTP(S) monitor на `https://proxy.example.com/healthz`, интервал 5 мин. Ответ должен быть 200. Этот endpoint публичный (`{"status":"ok"}`), без деталей.

---

## Часть 3. Получить токен и передать в PassDesk

После шага 2.4 у вас есть `PROXY_INBOUND_TOKEN` (сохранён в парольном менеджере). Этот токен — то, что заменит OpenRouter API key в env PassDesk.

### 3.1. Что передаём админу PassDesk

Три значения:

```
1. URL прокси:
   OCR_OPENROUTER_ENDPOINT=https://proxy.example.com/api/v1/chat/completions

2. Токен авторизации:
   OCR_API_KEY=<значение PROXY_INBOUND_TOKEN из шага 2.4>

3. Версия idempotency:
   OCR_IDEMPOTENCY_VERSION=v1
```

### 3.2. Как передавать

**Не отправлять токен** через обычный email, Slack без e2e, мессенджеры без E2E. Использовать:

- 1Password / Vaultwarden — поделиться записью с админом PassDesk;
- Одноразовая ссылка через `https://onetimesecret.com/` (или self-hosted аналог);
- Личная встреча / голосовой звонок.

### 3.3. Что админ PassDesk должен сделать

Полная инструкция — в [passdesk-migration.md](passdesk-migration.md). Кратко:

1. Подставить три переменные в env PassDesk (см. выше).
2. **Удалить настоящий OpenRouter API key из PassDesk env**. Окончательно. Из всех мест: `.env`, файлы CI, secret-сторадж.
3. В `server/src/services/ocr/ocrService.js` добавить два HTTP-заголовка к исходящему axios-запросу: `X-Request-Id` (uuid per attempt) и `X-Idempotency-Key` (стабильный per OCR-job, см. формулу в migration.md).
4. Перезапустить PassDesk-сервер.

Если у админа PassDesk Claude Code / Cursor — он может скопировать промт из [passdesk-agent-prompt.md](passdesk-agent-prompt.md) и поручить изменения агенту.

---

## Часть 4. Проверка интеграции end-to-end

### 4.1. С локальной машины — что прокси отвечает на чужие запросы

```bash
# [ADMIN-LOCAL] — без правильного Bearer
curl -sS -X POST https://proxy.example.com/api/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
# 401 — если ваш IP в allowlist /api/
# либо connection refused — если ваш IP НЕ в allowlist
```

Если ваш IP в allowlist и приходит 401 — auth работает.

### 4.2. С VPS PassDesk — что прокси видит правильный токен

```bash
# [ADMIN-PASSDESK] — с правильным токеном
curl -sS -X POST https://proxy.example.com/api/v1/chat/completions \
  -H 'Authorization: Bearer <PROXY_INBOUND_TOKEN>' \
  -H 'Content-Type: application/json' \
  -H 'X-Request-Id: test-smoke-1' \
  -d '{"messages":[{"role":"user","content":"скажи привет одним словом"}]}'
# 200, в теле {"choices":[{"message":{"content":"..."}}],...}
```

Если 200 — связка PassDesk → прокси → OpenRouter работает.

### 4.3. Через UI PassDesk — реальный сценарий

1. Зайти в PassDesk-портал.
2. Создать сотрудника, загрузить тестовый скан паспорта.
3. Дождаться распознавания (60-180 сек в зависимости от модели).
4. Открыть dashboard прокси `https://proxy.example.com/dashboard` (Basic Auth: `admin` / `DASHBOARD_PASS` из шага 2.4) — в таблице последних запросов должна появиться запись с `status='success'`.

### 4.4. Проверка idempotency (опционально)

Имитировать retry со стороны PassDesk — выполнить два curl с одинаковым `X-Idempotency-Key`:

```bash
# [ADMIN-PASSDESK]
KEY="test-job-$(date +%s)"
for i in 1 2; do
  curl -sS -X POST https://proxy.example.com/api/v1/chat/completions \
    -H "Authorization: Bearer <PROXY_INBOUND_TOKEN>" \
    -H "X-Idempotency-Key: $KEY" \
    -H "X-Request-Id: attempt-$i" \
    -H 'Content-Type: application/json' \
    -d '{"messages":[{"role":"user","content":"test"}]}' &
done
wait
```

В dashboard прокси должна появиться **одна** запись (с одним `upstream_id`) — это значит, что prоxy дедуплицировал параллельные ретраи на один upstream-вызов в OpenRouter.

---

## Часть 5. Эксплуатация

### 5.1. Где смотреть, когда что-то происходит

| Где | Что | Доступ |
|---|---|---|
| Telegram-чат | Алерты — первая сигнализация | вы получаете push |
| `https://proxy.example.com/dashboard` | Последние 100 запросов, агрегаты, p95 | Basic Auth, IP allowlist |
| `journalctl -u proxy_llm -f` | Runtime-логи прокси | ssh + sudo |
| `journalctl -u nginx -f` | nginx access/error logs | ssh + sudo |
| `https://proxy.example.com/healthz` | Публичный liveness | публичный, `{"status":"ok"}` |
| `curl http://127.0.0.1:3000/readyz` | Readiness (DB+DNS) | только на VPS |

### 5.2. Какие алерты приходят и что с ними делать

Полный список и cooldown — в [alerts-glossary.md](alerts-glossary.md). Самые важные:

| Алерт | Срочность | Что делать |
|---|---|---|
| `OpenRouter 401` | критично | проверить `OPENROUTER_API_KEY`, ротировать (см. 5.4) |
| `OpenRouter 402` | критично | пополнить баланс OpenRouter |
| `OpenRouter недоступен` | high | проверить `dig openrouter.ai` с VPS, дождаться восстановления |
| Серия ошибок ≥5 | medium | смотреть `journalctl` и dashboard |
| Высокий error rate >30% | medium | то же |
| Долгий запрос >150s | low | информационный, watchdog abort'нул |
| Stuck request | high (редко) | баг прокси, изучить логи |
| Прокси перезапущен | info | если неожиданно — смотреть, был ли crash |

### 5.3. Ежедневная эксплуатация

Утром:
- посмотреть Daily digest в Telegram (приходит в 09:00 МСК) — суммарные метрики за сутки;
- открыть dashboard — нет ли всплесков ошибок.

В течение дня: реагировать на алерты. Все алерты идут с cooldown, чтобы не флудить.

### 5.4. Ротация секретов

#### Ротация `OPENROUTER_API_KEY` (плановая, раз в 3-6 месяцев)

PassDesk не трогаем. Полный простой = пара секунд на рестарт.

```bash
# 1. На openrouter.ai создать новый ключ
# 2. [ROOT]
nano /etc/proxy_llm/.env
# заменить значение OPENROUTER_API_KEY=sk-or-v1-<новый>
systemctl restart proxy_llm
journalctl -u proxy_llm -f --since '1 minute ago'
# дождаться "proxy_llm started"

# 3. Сделать тестовый запрос через PassDesk → убедиться что 200
# 4. На openrouter.ai отозвать старый ключ
```

#### Ротация `PROXY_INBOUND_TOKEN` (плановая, раз в 6 месяцев или при компрометации)

Согласованная операция между прокси и PassDesk. Простой = до минуты.

```bash
# [ROOT]
NEW=$(openssl rand -hex 32)
echo "$NEW"   # передать админу PassDesk через защищённый канал

sed -i "s|^PROXY_INBOUND_TOKEN=.*|PROXY_INBOUND_TOKEN=${NEW}|" /etc/proxy_llm/.env
systemctl restart proxy_llm
# ВАЖНО: PassDesk запросы пока будут падать с 401

# [ADMIN-PASSDESK] — заменить OCR_API_KEY на новое значение, перезапустить PassDesk
# После этого 401 пропадёт.
```

#### Ротация `DASHBOARD_BASIC_AUTH_PASS`

В любой момент. Не влияет на работу OCR.

```bash
# [ROOT]
NEW=$(openssl rand -base64 24)
sed -i "s|^DASHBOARD_BASIC_AUTH_PASS=.*|DASHBOARD_BASIC_AUTH_PASS=${NEW}|" /etc/proxy_llm/.env
systemctl restart proxy_llm
echo "Новый dashboard пароль: $NEW"
```

### 5.5. Бэкапы и восстановление БД

Бэкап работает автоматически через cron (шаг 2.9). Файлы лежат в `/var/lib/proxy_llm/backups/prod.db.YYYYMMDDTHHMMSSZ.gz`, retention 30 дней.

Восстановление:

```bash
# [ROOT]
ls -lh /var/lib/proxy_llm/backups/      # выбрать нужный бэкап
systemctl stop proxy_llm
cp /var/lib/proxy_llm/prod.db /var/lib/proxy_llm/prod.db.before-restore
gunzip -c /var/lib/proxy_llm/backups/prod.db.<date>.gz > /var/lib/proxy_llm/prod.db
chown proxy_llm:proxy_llm /var/lib/proxy_llm/prod.db
systemctl start proxy_llm
journalctl -u proxy_llm -f --since '1 minute ago'
```

### 5.6. Обновление кода (zero-downtime)

```bash
# [ROOT]
cd /opt/proxy_llm
git fetch
git log HEAD..origin/main --oneline  # посмотреть что прилетает
git pull
npm ci
npm run build
npm prune --omit=dev

# Graceful restart — текущие активные запросы успеют завершиться до GRACEFUL_DRAIN_MS (60s)
systemctl restart proxy_llm
journalctl -u proxy_llm -f --since '1 minute ago'
curl -sS http://127.0.0.1:3000/healthz
```

В Telegram придёт "Прокси перезапущен" — это нормально.

### 5.7. Биллинг-сверка с OpenRouter

Каждая запись в журнале содержит `upstream_id` (OpenRouter `gen-…`). По нему ищем в OpenRouter dashboard конкретный вызов.

```bash
# [ROOT] — топ-20 самых тяжёлых запросов за сутки
sqlite3 /var/lib/proxy_llm/prod.db \
  "SELECT upstream_id, model_used, total_tokens, latency_ms,
          datetime(ts_received/1000,'unixepoch') AS ts
   FROM requests
   WHERE ts_received > strftime('%s','now','-1 day')*1000
   ORDER BY total_tokens DESC NULLS LAST LIMIT 20;"
```

### 5.8. Если прокси нужно временно остановить

```bash
# [ROOT]
systemctl stop proxy_llm
# PassDesk-запросы будут падать с connection refused → BullMQ ретраит до своих пределов.
# При длительной остановке PassDesk начнёт копить очередь OCR-задач — задачи не теряются,
# но и не выполняются, пока прокси не запустится обратно.

systemctl start proxy_llm
# Стартовая запись в Telegram + queue PassDesk начнёт разгребаться.
```

### 5.9. Emergency rollback (P0)

Если прокси не работает и срочно нужно вернуть OCR-функцию PassDesk — см. [deploy/INSTALL.md](../deploy/INSTALL.md) → раздел «Rollback (emergency)». Кратко:

1. На прокси VPS: `systemctl stop proxy_llm && systemctl disable proxy_llm`.
2. На PassDesk VPS вернуть в env:
   - `OCR_OPENROUTER_ENDPOINT=https://openrouter.ai/api/v1/chat/completions`
   - `OCR_API_KEY=<настоящий OpenRouter-ключ>`
3. Перезапустить PassDesk.

⚠️ Это нарушает security-принцип «OpenRouter key только на прокси». **После устранения инцидента обязательно:**
1. Восстановить прокси.
2. Вернуть PassDesk на URL прокси и `PROXY_INBOUND_TOKEN`.
3. Удалить настоящий OpenRouter-ключ из PassDesk env.
4. **Ротировать OpenRouter API key** на openrouter.ai — раз он временно лежал в PassDesk, считаем компрометацию возможной.

---

## Часть 6. Cheat sheet — где что лежит

```
/opt/proxy_llm/                       код, owned root:root
├── dist/server.js                    entry point (после npm run build)
├── package.json
├── deploy/
└── docs/

/etc/proxy_llm/                       конфиг, owned root:proxy_llm
└── .env                              секреты, chmod 640

/var/lib/proxy_llm/                   данные, owned proxy_llm:proxy_llm
├── prod.db                           SQLite журнал (WAL-mode)
├── prod.db-wal                       WAL-файл
├── prod.db-shm                       shared-memory
├── proxy_llm.state.json              startup state (для startup-alert)
└── backups/                          ежедневные .gz бэкапы, retention 30 дней

/etc/systemd/system/proxy_llm.service systemd unit
/etc/nginx/sites-available/proxy_llm.conf  nginx vhost
/etc/letsencrypt/live/proxy.example.com/   TLS-сертификаты certbot
```

Логи: только в `journald` (нет файлов в `/var/log/`):

```bash
journalctl -u proxy_llm -f                  # tail
journalctl -u proxy_llm -n 200 --no-pager   # последние 200 строк
journalctl -u proxy_llm --since '1 hour ago' -p err   # только errors за час
```

---

## Часть 7. Часто встречающиеся ошибки запуска

### `Config validation failed: PROXY_INBOUND_TOKEN must be at least 16 chars`

Не подставили `PROXY_INBOUND_TOKEN` в `/etc/proxy_llm/.env`. Сгенерируйте `openssl rand -hex 32` и вставьте.

### `Error: ENOENT: no such file or directory, open '.../001_initial.sql'`

Не должно случаться (SQL инлайнен в код), но если случилось — `npm run build` не отработал. Перезапустить сборку.

### `EADDRINUSE: address already in use 127.0.0.1:3000`

Порт занят. Смотрим:

```bash
ss -tlnp | grep ':3000'
```

Либо остановить соседний процесс, либо в `/etc/proxy_llm/.env` поменять `LISTEN_PORT` (и в nginx `proxy_pass http://127.0.0.1:<новый порт>`).

### `nginx: [emerg] cannot load certificate ".../fullchain.pem": ENOENT`

Сертификат ещё не выпущен, а финальный vhost уже положен. Откатиться на временный HTTP-only vhost (шаг 2.6), выпустить сертификат (шаг 2.7), затем поставить финальный.

### `journalctl` показывает `unable to bind to ...:3000 EACCES`

systemd-юнит запускается от `proxy_llm`, права на порт нужны только если порт < 1024. На 3000 такой проблемы быть не должно. Если LISTEN_PORT < 1024 — добавить в systemd unit `AmbientCapabilities=CAP_NET_BIND_SERVICE`.

### `OpenRouter 401` сразу при старте на тестовом запросе

Проверьте `OPENROUTER_API_KEY` в `/etc/proxy_llm/.env` — не подставлено ли значение по умолчанию `sk-or-v1-replace-with-real-key`.

### `OpenRouter 402` сразу при старте

Закончились кредиты в OpenRouter. Пополнить.

### `503 queue_full` при первом же запросе

Маловероятно, но возможно при `QUEUE_MAX_PENDING=1`. Проверьте `/etc/proxy_llm/.env`.

---

## Что делать, если этот документ не покрывает ваш случай

1. Посмотрите остальные документы:
   - [architecture.md](architecture.md) — что прокси делает и не делает
   - [runbook.md](runbook.md) — типовые операции
   - [alerts-glossary.md](alerts-glossary.md) — расшифровка каждого алерта
   - [passdesk-migration.md](passdesk-migration.md) — детали миграции PassDesk
2. Изучите код в `c:\Users\Usr\claudeprojects\proxy_llm\src\` — он компактный.
3. Запустите тесты локально (`npm test`).

---

## Часть 8. Мультитенантность — несколько клиентов на одном прокси

Прокси поддерживает несколько арендаторов: **у каждого свой токен**, свои лимиты
конкурентности, при желании — своя модель и свой ключ OpenRouter. Остаётся синхронным
шлюзом (никакого брокера/воркера на прокси — у клиентов свои очереди).

### 8.1. Реестр клиентов `clients.json`

Файл-реестр (пример — `deploy/clients.example.json`). Разместить и защитить:

```bash
# [ROOT]
cp /opt/proxy_llm/deploy/clients.example.json /etc/proxy_llm/clients.json
nano /etc/proxy_llm/clients.json          # прописать clientId, токены, модели, лимиты
chown root:proxy_llm /etc/proxy_llm/clients.json
chmod 640 /etc/proxy_llm/clients.json
```

Включить в `/etc/proxy_llm/.env`:

```env
CLIENTS_CONFIG_PATH=/etc/proxy_llm/clients.json
# рекомендуемые общие потолки для 2-3 клиентов (память на 2 ГБ VPS):
QUEUE_CONCURRENCY=3
QUEUE_MAX_PENDING=6
```

Правила загрузки:
- `CLIENTS_CONFIG_PATH` **не задан** → single-tenant legacy из `PROXY_INBOUND_TOKEN` (как раньше).
- Путь **задан, но файл отсутствует/битый/не проходит валидацию** → сервис **не стартует**
  (fail-fast; смотреть `journalctl -u proxy_llm`).
- `PROXY_INBOUND_TOKEN` **всегда** остаётся валидным (clientId `passdesk`) — совместимость.

Поля клиента — в шапке `deploy/clients.example.json` (clientId, tokens/tokenSha256,
defaultModel, allowedModels, fallbackModels, maxConcurrency, maxPending, openrouterApiKey, source).
Пустой `allowedModels` = клиент модель не выбирает (форс дефолта). Непустой → клиент может
прислать `model` из списка; иначе → `400 model_not_allowed`.

Применить: `systemctl reload`/`restart proxy_llm` (реестр читается на старте). Проверить:
`journalctl -u proxy_llm --since '1 min ago'` — не должно быть `ClientRegistryError`.

### 8.2. Онбординг нового клиента

1. Сгенерировать токен: `openssl rand -hex 32`, добавить запись клиента в `clients.json`
   (или положить `tokenSha256` = `printf %s '<токен>' | sha256sum`, чтобы не хранить открытый).
2. Добавить egress-IP клиента в `location /api/` nginx (`allow <IP>;` перед `deny all;`),
   `nginx -t && systemctl reload nginx`.
3. `systemctl reload proxy_llm`.
4. Передать клиенту токен по защищённому каналу + какие модели ему разрешены. Инструкция
   подключения — скилл `.claude/skills/connect-proxy-llm/`.

### 8.3. Учёт по клиентам

Журнал (`requests`) содержит колонку `client_id`; `/dashboard/stats.json` отдаёт `perClientDay`
(разбивка запросов/ошибок/токенов по клиентам). Серия ошибок (`error_streak`) считается
пер-клиентски. Память: пик ~80–100 МБ на один max-size (26 МБ) запрос, потолок задаёт
`QUEUE_MAX_PENDING`; если реальные payload меньше — снизьте `BODY_LIMIT_BYTES` и поднимите потолки.

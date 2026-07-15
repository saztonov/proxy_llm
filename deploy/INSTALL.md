# proxy_llm — пошаговое развёртывание на Ubuntu VPS

Целевая платформа: Ubuntu 22.04/24.04 LTS. На VPS уже должны быть установлены `nginx` и (желательно) `certbot`.

## Обозначения

- `[ROOT]` — выполнять от `root` (через `sudo -i` или `sudo <команда>`)
- `[PROXY_LLM]` — выполнять от системного пользователя `proxy_llm` (`sudo -u proxy_llm bash -c '...'`)
- `[ADMIN]` — выполнять с локальной машины (Windows) или с VPS под обычным админ-юзером

---

## Шаг 0. Предварительные проверки

```bash
# [ROOT]
ss -tlnp | grep ':3000'   # если порт занят — выбрать другой и заменить в .env + nginx
node --version            # должна быть v22.x; если нет — см. шаг 1

# sqlite3 CLI нужен скриптам backup-db.sh и wal-checkpoint.sh (иначе cron-бэкап
# падает молча, и это обнаруживается только когда бэкап понадобился)
apt-get install -y sqlite3
```

---

## Шаг 1. Установка Node.js 22 LTS

Предпочтения по убыванию security:

### Вариант A — системная установка через nodesource (рекомендуется)

```bash
# [ROOT]
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version           # v22.x
which node               # /usr/bin/node — owned root
```

### Вариант B — tarball в `/opt/node-v22/` (если на VPS уже стоит другая системная Node)

```bash
# [ROOT]
NODE_VER=22.13.0
cd /tmp
curl -fsSLO https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-x64.tar.xz
tar -xJf node-v${NODE_VER}-linux-x64.tar.xz -C /opt
mv /opt/node-v${NODE_VER}-linux-x64 /opt/node-v22
/opt/node-v22/bin/node --version
chown -R root:root /opt/node-v22
chmod -R go-w /opt/node-v22
# Не забыть: в proxy_llm.service заменить /usr/bin/node на /opt/node-v22/bin/node
```

⚠️ При этом варианте системная `node` в `PATH` — другой версии, а `npm ci` собирает
нативный `better-sqlite3` под ту Node, что нашёл в `PATH`. Соберёте системной — сервис
не стартует: `NODE_MODULE_VERSION ... requires 127`, `ERR_DLOPEN_FAILED`. Перед каждой
сборкой (и при установке, и при обновлении):

```bash
export PATH=/opt/node-v22/bin:$PATH
hash -r
node -v && npm -v        # v22.x; warning EBADENGINE в npm ci = PATH не тот
```

### Вариант C — nvm под proxy_llm (last resort)

Менее безопасно — Node binary окажется в writable-каталоге сервисного пользователя. Использовать только если соседние сервисы требуют другую системную Node И tarball не подходит.

---

## Шаг 2. Создание пользователя и каталогов

```bash
# [ROOT]
adduser --system --group --no-create-home --shell /usr/sbin/nologin proxy_llm
id proxy_llm

mkdir -p /opt/proxy_llm
mkdir -p /etc/proxy_llm
mkdir -p /var/lib/proxy_llm/backups

chown -R root:root            /opt/proxy_llm        && chmod 755 /opt/proxy_llm
chown -R root:proxy_llm       /etc/proxy_llm        && chmod 750 /etc/proxy_llm
chown -R proxy_llm:proxy_llm  /var/lib/proxy_llm    && chmod 700 /var/lib/proxy_llm

ls -ld /opt/proxy_llm /etc/proxy_llm /var/lib/proxy_llm
```

---

## Шаг 3. Размещение кода

TypeScript-проект. Простая `npm ci --omit=dev` пропустит TypeScript-компилятор, и `dist/server.js` не появится. Выбрать один из двух вариантов.

### Вариант A — build на VPS (рекомендуется для MVP)

```bash
# [ROOT]
cd /opt
git clone <repo-url> proxy_llm-src
mv proxy_llm-src/* /opt/proxy_llm/
mv proxy_llm-src/.gitignore /opt/proxy_llm/ 2>/dev/null || true
rm -rf proxy_llm-src

cd /opt/proxy_llm
npm ci
npm run build              # tsc → dist/
npm prune --omit=dev       # удалить devDeps

ls -la dist/server.js      # должен существовать

chown -R root:root /opt/proxy_llm
chmod -R go-w /opt/proxy_llm
```

### Вариант B — деплой CI-артефакта

```bash
# [ADMIN на локальной машине / CI]
npm ci
npm run build
tar -czf proxy_llm-bundle.tgz dist/ package.json package-lock.json deploy/ scripts/ src/views/

# [ROOT на VPS]
cd /opt/proxy_llm
tar -xzf /tmp/proxy_llm-bundle.tgz
npm ci --omit=dev

ls -la dist/server.js
chown -R root:root /opt/proxy_llm
chmod -R go-w /opt/proxy_llm
```

---

## Шаг 4. Создание `.env`

```bash
# [ROOT]
PROXY_INBOUND_TOKEN=$(openssl rand -hex 32)
DASHBOARD_PASS=$(openssl rand -base64 24)

cp /opt/proxy_llm/.env.example /etc/proxy_llm/.env

# Подправить руками:
nano /etc/proxy_llm/.env
# обязательно заменить:
#   PROXY_INBOUND_TOKEN=<сгенерированный выше>
#   OPENROUTER_API_KEY=<настоящий ключ OpenRouter>
#   OPENROUTER_HTTP_REFERER=<URL PassDesk-сервиса>
#   DASHBOARD_BASIC_AUTH_PASS=<сгенерированный выше>
#   TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID (если используется)
#   DB_PATH=/var/lib/proxy_llm/prod.db

chown root:proxy_llm /etc/proxy_llm/.env
chmod 640 /etc/proxy_llm/.env

# Сохранить токены в надёжное место (1Password/Vaultwarden):
echo "PROXY_INBOUND_TOKEN=$PROXY_INBOUND_TOKEN"
echo "DASHBOARD_PASS=$DASHBOARD_PASS"
```

---

## Шаг 5. systemd unit

```bash
# [ROOT]
cp /opt/proxy_llm/deploy/systemd/proxy_llm.service /etc/systemd/system/proxy_llm.service

# Если используется tarball-Node (Вариант B в шаге 1) — заменить ExecStart:
nano /etc/systemd/system/proxy_llm.service
# ExecStart=/opt/node-v22/bin/node dist/server.js

systemctl daemon-reload
systemctl enable proxy_llm
# Пока НЕ стартуем — сначала nginx + сертификат.
```

---

## Шаг 6. nginx vhost — ВРЕМЕННЫЙ HTTP-only для ACME

⚠️ Финальный vhost ссылается на `/etc/letsencrypt/live/.../fullchain.pem`, которого ещё не существует — `nginx -t` упадёт. Поэтому сначала кладём временный HTTP-only vhost.

```bash
# [ROOT]
cat > /etc/nginx/sites-available/proxy_llm.conf <<'EOF'
# ВРЕМЕННЫЙ HTTP-only vhost — будет заменён после получения сертификата
server {
    listen 80;
    server_name proxy.example.com;

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

---

## Шаг 7. Выпуск TLS-сертификата + замена vhost на финальный

```bash
# [ROOT]
apt-get install -y certbot python3-certbot-nginx

certbot --nginx -d proxy.example.com --non-interactive --agree-tos -m admin@example.com

# Теперь заменить vhost на финальный
cp /etc/nginx/sites-available/proxy_llm.conf /etc/nginx/sites-available/proxy_llm.conf.bak
cp /opt/proxy_llm/deploy/nginx/proxy_llm.conf /etc/nginx/sites-available/proxy_llm.conf

# Подставить: server_name, IP PassDesk в /api/, IP админа в /dashboard,
# проверить пути ssl_certificate*
nano /etc/nginx/sites-available/proxy_llm.conf

nginx -t && systemctl reload nginx

# Проверка автообновления:
systemctl status certbot.timer
```

**Альтернатива (без временного vhost):** `certbot certonly --standalone -d proxy.example.com` ДО старта nginx (требует свободный порт 80). После — положить финальный vhost и `systemctl reload nginx`.

---

## Шаг 8. Старт сервиса

```bash
# [ROOT]
systemctl start proxy_llm
systemctl status proxy_llm
journalctl -u proxy_llm -f --since '1 minute ago'
# ждём "proxy_llm started" в логах

# Smoke-test изнутри VPS (минуя nginx):
curl -sS http://127.0.0.1:3000/healthz
# должно вернуть {"status":"ok"}

# Smoke-test через nginx (с PassDesk VPS или whitelisted IP):
curl -sS https://proxy.example.com/healthz
```

---

## Шаг 9. Cron для бэкапа БД, WAL maintenance и ротации логов

```bash
# [ROOT]
ls -l /opt/proxy_llm/scripts/*.sh          # нужен бит +x; если нет — chmod +x /opt/proxy_llm/scripts/*.sh

crontab -u proxy_llm -e
# добавить:
0 3 * * * /opt/proxy_llm/scripts/backup-db.sh
30 3 * * 0 /opt/proxy_llm/scripts/wal-checkpoint.sh
0 4 * * 0 /opt/proxy_llm/scripts/rotate-logs.sh
```

Сразу проверить, что бэкап реально отрабатывает, — cron о своих ошибках не сообщит:

```bash
sudo -u proxy_llm /opt/proxy_llm/scripts/backup-db.sh && ls -la /var/lib/proxy_llm/backups/
```

---

## Шаг 10. Переключение PassDesk на прокси

См. `docs/passdesk-migration.md` и (для агента) `docs/passdesk-agent-prompt.md`.

---

## Rollback (preferred — не трогать PassDesk)

Цель: PassDesk остаётся на URL прокси, ключ OpenRouter не возвращается в PassDesk env.

```bash
# [ROOT]
systemctl stop proxy_llm
journalctl -u proxy_llm -n 200 --no-pager

cd /opt/proxy_llm
git log --oneline -5
git checkout <previous-good-commit>
npm ci && npm run build && npm prune --omit=dev

systemctl start proxy_llm
journalctl -u proxy_llm -f --since '1 minute ago'
curl -sS http://127.0.0.1:3000/healthz
```

## Rollback (emergency — вернуть прямой OpenRouter в PassDesk)

⚠️ **Применять только при P0-инциденте.** Временно нарушает security-принцип "OpenRouter key только на прокси VPS".

```bash
# [ROOT на прокси VPS]
systemctl stop proxy_llm
systemctl disable proxy_llm

# [ADMIN PassDesk VPS] — в server/.env:
#   OCR_OPENROUTER_ENDPOINT=https://openrouter.ai/api/v1/chat/completions
#   OCR_API_KEY=<настоящий OpenRouter-ключ>
# Перезапустить PassDesk-сервер.
```

**Чек-лист возврата к secure-состоянию после устранения инцидента:**

1. Починить прокси (preferred rollback выше).
2. Убедиться, что прокси работает стабильно ≥ 30 минут.
3. На PassDesk VPS вернуть:
   - `OCR_OPENROUTER_ENDPOINT=https://proxy.example.com/api/v1/chat/completions`
   - `OCR_API_KEY=<PROXY_INBOUND_TOKEN>`
4. **Удалить настоящий OpenRouter-ключ из PassDesk env** (`.env`, файлы CI, секреты).
5. **Ротировать OpenRouter API key** на стороне OpenRouter.
6. Перезапустить PassDesk-сервер.
7. Записать инцидент в runbook.

---

## Полное удаление прокси

```bash
# [ROOT]
systemctl stop proxy_llm
systemctl disable proxy_llm
rm /etc/nginx/sites-enabled/proxy_llm.conf
nginx -t && systemctl reload nginx

rm -rf /opt/proxy_llm /etc/proxy_llm /var/lib/proxy_llm
rm /etc/systemd/system/proxy_llm.service
rm /etc/nginx/sites-available/proxy_llm.conf
systemctl daemon-reload
userdel proxy_llm
groupdel proxy_llm 2>/dev/null
```

# proxy_llm — обновление на VPS и выдача токенов клиентам

Короткий чек-лист на каждый день. Развёртывание с нуля — `deploy/INSTALL.md`, полное руководство админа — `docs/operator-guide.md`, реакция на алерты — `docs/runbook.md`.

Раскладка на VPS:

```
/opt/proxy_llm/          код (root:root), dist/server.js — entry point
/etc/proxy_llm/.env      секреты (root:proxy_llm, 640)
/etc/proxy_llm/clients.json  реестр клиентов (root:proxy_llm, 640)
/var/lib/proxy_llm/      prod.db + backups/ (proxy_llm:proxy_llm, 700)
```

Node слушает только `127.0.0.1:3000`, наружу — через nginx. Логи только в journald: `journalctl -u proxy_llm -f`.

---

## 1. Обновление кода

Всё от `root`.

```bash
# --- Бэкап перед обновлением ---
sudo -u proxy_llm /opt/proxy_llm/scripts/backup-db.sh        # → /var/lib/proxy_llm/backups/*.gz
cp /etc/proxy_llm/.env /etc/proxy_llm/.env.bak.$(date +%F)
cp /etc/proxy_llm/clients.json /etc/proxy_llm/clients.json.bak.$(date +%F) 2>/dev/null || true
cd /opt/proxy_llm && git rev-parse HEAD | tee /root/proxy_llm-prev-commit

# --- Забрать код ---
cd /opt/proxy_llm
git fetch origin
git log HEAD..origin/main --oneline    # посмотреть, что приедет
git checkout main
git pull --ff-only origin main

# --- Сборка ---
npm ci                                 # именно ci, с devDeps: без tsc не соберётся dist/
npm run build
npm prune --omit=dev
ls -la dist/server.js dist/views/dashboard.eta   # оба должны существовать

# --- Права ---
chown -R root:root /opt/proxy_llm
chmod -R go-w /opt/proxy_llm

# --- Рестарт: graceful, ждёт активные запросы до GRACEFUL_DRAIN_MS (60s) ---
systemctl restart proxy_llm
systemctl status proxy_llm --no-pager
journalctl -u proxy_llm -n 50 --no-pager --since '1 min ago'

# --- Проверка ---
curl -sS http://127.0.0.1:3000/healthz     # {"status":"ok"}
curl -sS http://127.0.0.1:3000/readyz
```

Отдельного шага миграций нет — `openDb()` применяет их идемпотентно при каждом старте.
`npm run migrate` не запускать: скрипт указывает на несуществующий `dist/storage/migrate.js`.

## 2. Откат

```bash
cd /opt/proxy_llm
git checkout $(cat /root/proxy_llm-prev-commit)
npm ci && npm run build && npm prune --omit=dev
systemctl restart proxy_llm
curl -sS http://127.0.0.1:3000/healthz
```

Восстановление БД из бэкапа — `docs/operator-guide.md`, раздел 5.5.

---

## 3. Включение реестра клиентов (разово)

Пока `CLIENTS_CONFIG_PATH` не задан, работает legacy-режим: валиден только `PROXY_INBOUND_TOKEN`, он же `clientId=passdesk`. Чтобы завести несколько потребителей — создать файл сразу с первым клиентом:

```bash
set +o history                          # чтобы токен не осел в ~/.bash_history
TOKEN=$(openssl rand -hex 32)

cat > /etc/proxy_llm/clients.json <<EOF
{
  "clients": [
    {
      "clientId": "estimat",
      "tokens": ["$TOKEN"],
      "defaultModel": "google/gemini-2.5-flash",
      "allowedModels": ["google/gemini-2.5-flash"],
      "maxConcurrency": 2,
      "maxPending": 2
    }
  ]
}
EOF

chown root:proxy_llm /etc/proxy_llm/clients.json
chmod 640 /etc/proxy_llm/clients.json
python3 -m json.tool /etc/proxy_llm/clients.json >/dev/null && echo "JSON OK"

nano /etc/proxy_llm/.env
#   CLIENTS_CONFIG_PATH=/etc/proxy_llm/clients.json
#   QUEUE_CONCURRENCY=3      # общий потолок, держать >= суммы maxConcurrency клиентов
#   QUEUE_MAX_PENDING=6

systemctl restart proxy_llm
journalctl -u proxy_llm --since '1 min ago' | grep -i ClientRegistryError   # должно быть пусто

echo "TOKEN estimat: $TOKEN"            # передать клиенту, затем:
unset TOKEN; set -o history
```

`deploy/clients.example.json` — образец структуры для чтения, а не заготовка для `cp`. Плейсхолдеры в нём (`REPLACE_ME`) намеренно не проходят валидацию: если скопировать шаблон и забыть заменить токен, сервис откажется стартовать с понятным сообщением, а не запустится с токеном, известным всем, у кого есть доступ к репозиторию.

Если `CLIENTS_CONFIG_PATH` задан, а файл битый или отсутствует — сервис не стартует (fail-fast). Перед рестартом проверять синтаксис:

```bash
python3 -m json.tool /etc/proxy_llm/clients.json > /dev/null && echo OK
```

---

## 4. Подключение нового потребителя

**Где ведутся токены:** `/etc/proxy_llm/clients.json` на VPS. В git его нет и быть не должно — в репозитории только шаблон `deploy/clients.example.json`. Второе место хранения — менеджер секретов (1Password/Vaultwarden): после выдачи открытый токен взять больше неоткуда.

**GUI для этого нет.** Единственная веб-страница `/dashboard` — read-only мониторинг. Онбординг — только через SSH.

### Шаг 1 — сгенерировать токен и добавить клиента

Через `jq` — не сломает синтаксис файла, в отличие от правки руками:

```bash
set +o history
command -v jq >/dev/null || apt-get install -y jq

CLIENT=mosgate
TOKEN=$(openssl rand -hex 32)

cp /etc/proxy_llm/clients.json /etc/proxy_llm/clients.json.bak.$(date +%F-%H%M%S)

jq --arg id "$CLIENT" --arg t "$TOKEN" '.clients += [{
  clientId: $id,
  tokens: [$t],
  defaultModel: "google/gemini-2.5-flash",
  allowedModels: ["google/gemini-2.5-flash"],
  maxConcurrency: 1,
  maxPending: 2
}]' /etc/proxy_llm/clients.json > /tmp/clients.new.json

python3 -m json.tool /tmp/clients.new.json >/dev/null \
  && install -o root -g proxy_llm -m 640 /tmp/clients.new.json /etc/proxy_llm/clients.json
rm -f /tmp/clients.new.json

echo "TOKEN $CLIENT: $TOKEN"
unset TOKEN; set -o history
```

Чтобы открытый токен вообще не лежал на диске — класть только хэш:

```bash
set +o history
TOKEN=$(openssl rand -hex 32)
HASH=$(printf %s "$TOKEN" | sha256sum | awk '{print $1}')

jq --arg id "beta" --arg h "$HASH" '.clients += [{
  clientId: $id, tokenSha256: [$h], maxConcurrency: 1, maxPending: 2
}]' /etc/proxy_llm/clients.json > /tmp/c.json \
  && install -o root -g proxy_llm -m 640 /tmp/c.json /etc/proxy_llm/clients.json && rm /tmp/c.json

echo "TOKEN beta (больше нигде не хранится): $TOKEN"
unset TOKEN HASH; set -o history
```

### Шаг 2 — поля клиента

| Поле | Обяз. | Смысл |
|---|---|---|
| `clientId` | да | уникальный id для журнала, лимитов, алертов |
| `tokens[]` / `tokenSha256[]` | нужен ≥1 | открытые токены (≥16 символов) либо их sha256 в hex |
| `defaultModel` | нет | модель, если клиент не прислал `model`; иначе глобальная `OPENROUTER_MODEL` |
| `allowedModels[]` | нет | белый список. Пусто = клиент **не выбирает** модель (форс `defaultModel`), а не «всё разрешено» |
| `fallbackModels[]` | нет | fallback OpenRouter |
| `maxConcurrency` | нет | 1..20, одновременных upstream-вызовов |
| `maxPending` | нет | 1..1000, очередь сверх `maxConcurrency` |
| `openrouterApiKey` | нет | свой ключ OpenRouter клиента (биллинговая изоляция) |
| `source` | нет | тег журнала, по умолчанию = `clientId` |

Схема валидируется строго: неизвестное поле или дублирующийся `clientId`/токен → сервис не стартует.

### Шаг 3 — разрешить IP клиента в nginx

```bash
nano /etc/nginx/sites-available/proxy_llm.conf   # allow <egress-IP клиента>;  перед deny all;
nginx -t && systemctl reload nginx
```

### Шаг 4 — применить реестр

```bash
systemctl restart proxy_llm      # именно restart: реестр читается только на старте, ExecReload нет
journalctl -u proxy_llm --since '1 min ago'
```

Токен передать клиенту защищённым каналом (1Password / onetimesecret). Инструкция по подключению для его разработчиков — скилл `.claude/skills/connect-proxy-llm/`.

### Проверка

```bash
curl -sS https://proxy.example.com/api/v1/chat/completions \
  -H "Authorization: Bearer <токен клиента>" -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"ping"}]}'
```

Ожидаемо 200. Затем запись с нужным `client_id` появится в `/dashboard`.
Битый токен → 401 `invalid bearer token`; модель вне `allowedModels` → 400 `model_not_allowed`.

---

## 5. Ротация и отзыв токена

`tokens` — массив, поэтому ротация возможна без окна отказов: какое-то время валидны оба токена.

```bash
# 1) добавить новый рядом со старым
set +o history
NEW=$(openssl rand -hex 32)
jq --arg id estimat --arg t "$NEW" '(.clients[] | select(.clientId==$id) | .tokens) += [$t]' \
  /etc/proxy_llm/clients.json > /tmp/c.json \
  && install -o root -g proxy_llm -m 640 /tmp/c.json /etc/proxy_llm/clients.json && rm /tmp/c.json
systemctl restart proxy_llm
echo "новый токен estimat: $NEW"; unset NEW; set -o history

# 2) когда клиент переключился — убрать старый
jq --arg id estimat --arg old '<старый токен>' \
  '(.clients[] | select(.clientId==$id) | .tokens) |= map(select(. != $old))' \
  /etc/proxy_llm/clients.json > /tmp/c.json \
  && install -o root -g proxy_llm -m 640 /tmp/c.json /etc/proxy_llm/clients.json && rm /tmp/c.json
systemctl restart proxy_llm
```

Отзыв клиента целиком:

```bash
jq --arg id estimat '.clients |= map(select(.clientId != $id))' \
  /etc/proxy_llm/clients.json > /tmp/c.json \
  && install -o root -g proxy_llm -m 640 /tmp/c.json /etc/proxy_llm/clients.json && rm /tmp/c.json
systemctl restart proxy_llm
```

Ротация legacy-токена `PROXY_INBOUND_TOKEN` — только с окном 401-ошибок, см. `docs/operator-guide.md` 5.4.

---

## 6. Ограничения, о которых надо помнить

- **Rate limit и дневных квот на клиента нет.** Есть только лимит одновременности (`maxConcurrency` + `maxPending`) — это back-pressure, не throttling: клиент, шлющий запросы последовательно, по объёму ничем не ограничен. Ограничение частоты только глобальное, по IP, в nginx (`rate=60r/m`, `limit_conn 3`).
- **IP-allowlist не пер-клиентский** — общий `allow` на `location /api/`. Привязки «токен X только с IP Y» нет: любой клиент из allowlist с валидным токеном пройдёт.
- **Дайджест в Telegram — агрегат по всему прокси**, без разбивки по клиентам.

Пер-клиентская статистика:

```bash
curl -sS -u admin:<DASHBOARD_PASS> http://127.0.0.1:3000/dashboard/stats.json | python3 -m json.tool
# поле perClientDay (в HTML-дашборде его нет)

sqlite3 /var/lib/proxy_llm/prod.db \
  "select client_id, count(*), sum(total_tokens) from requests
   where ts_received > (strftime('%s','now')-86400)*1000 group by client_id;"
```

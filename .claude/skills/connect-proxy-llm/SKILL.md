---
name: connect-proxy-llm
description: Подключение стороннего проекта к LLM-прокси proxy_llm (OpenAI-совместимый POST /api/v1/chat/completions) по персональному Bearer-токену клиента, а также доработка уже подключённого проекта под выбор модели. Использовать при интеграции или отладке сервиса, которому нужен LLM-вызов через центральный прокси, а не напрямую в OpenRouter/OpenAI. Учитывает ограничения прокси: политика моделей задаётся оператором пер-клиентски (allowedModels — пусто/список/«*»), стриминг запрещён, пер-клиентские лимиты конкурентности, IP-allowlist.
---

# Подключение проекта к LLM-прокси `proxy_llm`

`proxy_llm` — центральный прокси между вашим сервисом и OpenRouter. Он прячет реальный
ключ OpenRouter, ведёт журнал вызовов, шлёт алерты и применяет пер-клиентскую политику
моделей и лимитов. Для клиента это **OpenAI-совместимый Chat Completions API**: любой
OpenAI-клиент подключается сменой `base_url` и `api_key`, без переписывания логики.

**Скилл переносимый.** Скопируйте каталог `connect-proxy-llm/` в `.claude/skills/`
вашего проекта — инструкции самодостаточны (кроме раздела 9 «Онбординг», он для
оператора прокси).

**Уже подключены и хотите выбирать модель?** Сразу к §8 «Как начать выбирать модель».

## 0. Что нужно до старта

Получить у **оператора proxy_llm**:

1. **Базовый URL** — прод обычно `https://<proxy-domain>` (напр. `https://proxy.example.com`),
   локально/дев — `http://127.0.0.1:3000`.
2. **Персональный токен вашего клиента** (случайный 32-байт hex). У каждого проекта свой —
   не переиспользовать между проектами и не передавать соседям: к токену привязаны ваш
   `clientId`, лимиты, политика моделей и журнал. Хранить в секрете сервиса
   (env/secret-storage), **не в коде и не в репозитории**, передавать только по
   HTTPS/защищённому каналу.
3. **Вашу политику моделей** — `clientId`, дефолтную модель и `allowedModels`
   (пусто = выбор запрещён / список / `*` = любая модель OpenRouter). От этого зависит,
   можете ли вы вообще присылать `model` (см. §1).
4. Попросить оператора **добавить egress-IP вашего сервиса в nginx-allowlist** — иначе
   прокси вернёт вам отказ ещё до токена (см. §9). Это обязательный шаг для прода.

Клиентские env-переменные (имена — на ваш вкус, здесь по всему скиллу используются):

```env
PROXY_LLM_BASE_URL=https://proxy.example.com
PROXY_LLM_TOKEN=<персональный токен, выданный оператором>
PROXY_LLM_MODEL=proxy
```

`PROXY_LLM_MODEL=proxy` — заглушка «модель выбирает прокси». Держать модель в конфиге, а не
в коде, стоит с самого начала: тогда переход на свой выбор модели (§8) — это смена значения
env, а не правка кода.

## 1. Как устроен прокси и ключевые ограничения

Прочитайте до интеграции — прокси намеренно отличается от прямого OpenAI/OpenRouter:

- **Один эндпоинт:** `POST /api/v1/chat/completions` (легаси-алиас `POST /v1/chat/completions`,
  идентичен). Эндпоинта `/v1/models` **нет**, Anthropic `/v1/messages` **нет**. Список
  доступных вам моделей программно не узнать — спрашивать у оператора.
- **Модель: зависит от вашего `allowedModels`.** Три режима, свой уточните у оператора:
  - **пусто** — выбор запрещён: присланный `model` **игнорируется**, всегда идёт дефолтная
    модель клиента + её fallback-цепочка (поведение по умолчанию);
  - **список** (напр. `["google/gemini-2.5-flash","anthropic/claude-sonnet-5"]`) — можно
    прислать `model` из него; не из него → **400 `model_not_allowed`** (в теле — `allowed`);
  - **`["*"]`** — любая модель OpenRouter.

  **Заглушки.** `proxy`, `default`, `auto` в поле `model` означают «модель не выбираю» →
  дефолтная модель клиента + fallback. Так же трактуются отсутствующий и пустой `model`.
  Регистр и пробелы по краям не важны. Это **единственный** безопасный способ прислать
  «пустышку»: любая другая строка при непустом `allowedModels` — это **реальный выбор**,
  который изменит роутинг и биллинг.

  **Явный выбор отключает fallback.** Прислали конкретную модель → в OpenRouter уходит
  одиночный `model` без `models[]`: недоступен провайдер — получите ошибку, а не тихий
  переезд на резервную модель. Нужна отказоустойчивость — не выбирайте модель (заглушка
  либо не слать `model`).
- **Стриминг запрещён.** `"stream": true` → **HTTP 400** `streaming_not_supported`.
  Только non-streaming запрос/ответ.
- **Молча вырезаются** из тела: `models`, `provider`, `route`, `transforms`, `plugins`,
  `stream_options`, `debug` (защита от обхода серверного роутинга/провайдера). В частности,
  **свою fallback-цепочку `models[]` прислать нельзя** — её задаёт оператор в `fallbackModels`.
- **Дедлайн запроса** ~190 с (`REQUEST_DEADLINE_MS`) → при исчерпании **504** `deadline_exceeded`.
- **Лимит тела запроса** ~26 МБ → **413** `payload_too_large`.
- **Два потолка конкурентности:** ваш пер-клиентский (`maxConcurrency`/`maxPending`) и общий
  на весь прокси. Переполнение любого → **503** `queue_full` + `Retry-After: 10`.
  Обрабатывайте ретраем с backoff (см. §6).
- **Только server-to-server.** CORS не настроен — **из браузера не вызывать**.
- **Ответ** — стандартный OpenAI JSON (`id`, `model`, `choices`, `usage`), плюс заголовки
  `x-proxy-request-id` (id запроса в прокси) и `x-openrouter-request-id` (upstream `gen-…`
  для биллинг-сверки).

## 2. Аутентификация

Каждый запрос предъявляет ваш персональный токен в заголовке:

```
Authorization: Bearer <PROXY_LLM_TOKEN>
```

Токен идентифицирует ваш `clientId` — к нему привязаны лимиты, политика моделей и журнал.
Отсутствует/неверный → **401** `unauthorized`. Проверка идёт до чтения тела.

## 3. Быстрые проверки (curl)

```bash
BASE=https://proxy.example.com
TOKEN=<ваш-токен>

# Публичный liveness (без токена)
curl -s "$BASE/healthz"                    # -> {"status":"ok"}

# Минимальный вызов: model не шлём — идёт дефолтная модель вашего клиента.
curl -s "$BASE/api/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: $(uuidgen)" \
  -d '{"messages":[{"role":"user","content":"ping"}]}'
# -> OpenAI-ответ: {"id":...,"model":...,"choices":[...],"usage":{...}}
#    заголовки ответа: x-proxy-request-id, x-openrouter-request-id

# Модель не выбираем — заглушка (эквивалент отсутствия model):
curl -s "$BASE/api/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"proxy","messages":[{"role":"user","content":"ping"}]}'
# -> 200, в ответе model = дефолтная модель вашего клиента

# Явный выбор (если оператор разрешил; ОТКЛЮЧАЕТ fallback-цепочку):
curl -s "$BASE/api/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"google/gemini-2.5-flash","messages":[{"role":"user","content":"ping"}]}'
# -> 200, в ответе model = запрошенная

# Модель вне вашего allowlist:
curl -s "$BASE/api/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"no/such-model","messages":[{"role":"user","content":"x"}]}'
# -> 400 {"error":{"code":"model_not_allowed","allowed":["google/gemini-2.5-flash"]}}
#    (при allowedModels:["*"] вместо этого придёт ошибка OpenRouter — модели просто нет)

# Стриминг запрещён:
curl -s "$BASE/api/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hi"}],"stream":true}'
# -> 400 {"error":{"code":"streaming_not_supported",...}}

# Без токена:
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/v1/chat/completions" \
  -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"x"}]}'
# -> 401
```

## 4. Опциональные заголовки (рекомендуются)

| Заголовок | Назначение | Ограничения |
|---|---|---|
| `X-Request-Id` | Трассировка одной **попытки**. Уникальный на каждую попытку (UUID). | ≤128 символов, иначе прокси сгенерит свой |
| `X-Idempotency-Key` | Стабильный ключ **логической задачи**. Конкурентные запросы с одинаковым ключом схлопываются в **один** upstream-вызов (дедуп). | ≤256 символов |

Правило `X-Idempotency-Key`:
- **должен совпадать** между ретраями одной и той же задачи;
- **не должен совпадать** между разными задачами/входами/промптами;
- при смене промпта/схемы поднимайте версию в ключе, чтобы старые ключи не конфликтовали.

Ключ скоупится по вашему `clientId`, поэтому совпадение ключа с другим клиентом безопасно.

Стабильный ключ обычно строят как хэш от устойчивых атрибутов задачи (пример — sha256):

```js
const crypto = require('node:crypto');
const idempVer = process.env.PROXY_LLM_IDEMPOTENCY_VERSION || 'v1';
const input = [taskId, inputHashOrKey, promptNameOrHash, idempVer].filter(Boolean).join(':');
const idempotencyKey = crypto.createHash('sha256').update(input).digest('hex');
```

В ответе смотрите `x-proxy-request-id` / `x-openrouter-request-id` для логов и сверки
биллинга (по `x-openrouter-request-id = gen-…` вызов находится в биллинге OpenRouter).

## 5. Готовые клиенты

### 5.1 Python — OpenAI SDK

`base_url` указывает на `…/api/v1`, SDK сам добавит `/chat/completions`.

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url=f"{os.environ['PROXY_LLM_BASE_URL']}/api/v1",
    api_key=os.environ["PROXY_LLM_TOKEN"],
)

resp = client.chat.completions.create(
    # SDK требует непустой model. "proxy" = заглушка «модель не выбираю» -> дефолт клиента
    # + fallback. Реальный слаг здесь = явный выбор (нужен allowedModels, fallback отключится).
    model=os.environ.get("PROXY_LLM_MODEL", "proxy"),
    messages=[{"role": "user", "content": "ping"}],
    # stream НЕ задавать: stream=True -> 400
    extra_headers={"X-Request-Id": os.urandom(16).hex()},
)
print(resp.choices[0].message.content)
```

### 5.2 Python — raw `requests` (полный контроль над кодами/ретраем)

```python
import os, uuid, requests

BASE  = os.environ["PROXY_LLM_BASE_URL"]
TOKEN = os.environ["PROXY_LLM_TOKEN"]
MODEL = os.environ.get("PROXY_LLM_MODEL", "proxy")   # "proxy" = заглушка

def chat(messages, idempotency_key=None):
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
        "X-Request-Id": str(uuid.uuid4()),          # новый на каждую попытку
    }
    if idempotency_key:
        headers["X-Idempotency-Key"] = idempotency_key  # стабильный на задачу
    r = requests.post(f"{BASE}/api/v1/chat/completions",
                      headers=headers,
                      json={"model": MODEL, "messages": messages},
                      timeout=200)
    if r.status_code >= 400:
        body = r.json() if "application/json" in r.headers.get("content-type", "") else {}
        err = body.get("error") or {}
        if err.get("code") == "model_not_allowed":   # не ретраить: конфиг, а не сбой
            raise RuntimeError(f"model {MODEL!r} запрещена, разрешены: {err.get('allowed')}")
        raise RuntimeError(f"{r.status_code} {err.get('code', '')}: {r.text[:300]}")
    return r.json()
```

### 5.3 Node/TypeScript — OpenAI SDK

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: `${process.env.PROXY_LLM_BASE_URL}/api/v1`,
  apiKey: process.env.PROXY_LLM_TOKEN,
});

const resp = await client.chat.completions.create({
  // 'proxy' = заглушка «модель не выбираю» -> дефолт клиента + fallback.
  model: process.env.PROXY_LLM_MODEL || 'proxy',
  messages: [{ role: 'user', content: 'ping' }],
  // stream НЕ задавать
}, { headers: { 'X-Request-Id': crypto.randomUUID() } });

console.log(resp.choices[0].message.content);
```

### 5.4 Node/TypeScript — мини-клиент на `fetch` (различает 503/504)

```ts
import crypto from 'node:crypto';

class ProxyLLM {
  constructor(private base = process.env.PROXY_LLM_BASE_URL!,
              private token = process.env.PROXY_LLM_TOKEN!,
              private model = process.env.PROXY_LLM_MODEL || 'proxy') {}

  // { status, body } — чтобы вызывающий код различал 503 queue_full / 504 от прочего.
  async chat(messages: unknown[], idempotencyKey?: string): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      'X-Request-Id': crypto.randomUUID(),            // новый на каждую попытку
    };
    if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey; // стабильный на задачу
    const res = await fetch(`${this.base}/api/v1/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify({ model: this.model, messages }),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }
}
```

Все примеры читают `PROXY_LLM_*` из окружения — токен в коде не хардкодить.

## 6. Ошибки и ретраи

Тело ошибки, сгенерированной **прокси**: `{ "error": { "code": "...", "message": "..." } }`.

| код | HTTP | причина | что делать |
|---|---|---|---|
| `unauthorized` | 401 | нет/неверный Bearer | проверить токен |
| `invalid_request` | 400 | тело не JSON-объект или `messages` пустой/не массив | исправить тело |
| `streaming_not_supported` | 400 | прислан `stream:true` | убрать `stream` |
| `model_not_allowed` | 400 | `model` не входит в разрешённый вам список (`allowed` в теле) | взять модель из `allowed`, либо не слать `model` / прислать заглушку `proxy` |
| `payload_too_large` | 413 | тело > ~26 МБ | уменьшить запрос |
| `queue_full` | 503 | очередь прокси переполнена (есть `Retry-After`) | **ретрай** с backoff, уважая `Retry-After` |
| `dedup_full` | 503 | исчерпан лимит активных idempotency-ключей (есть `Retry-After`) | **ретрай** с backoff |
| `deadline_exceeded` | 504 | превышен серверный дедлайн ~190 с | **ретрай** (тот же idempotency-key) |
| `attempt_timeout` / `network_error` | 504 | таймаут/сбой связи прокси↔OpenRouter | **ретрай** |
| `upstream_response_too_large` | 502 | ответ OpenRouter превысил лимит | не ретраить, уменьшить задачу |
| `internal` | 500 | внутренняя ошибка прокси | ограниченный ретрай |

**Важно:** «настоящие» ошибки OpenRouter (например, 401/402 по ключу OpenRouter, 429 rate
limit, 5xx) прокси **пробрасывает как есть** — со статусом и телом OpenRouter, а не в своём
envelope. То есть не всякий 4xx/5xx имеет форму `{error:{code}}`; ориентируйтесь на
HTTP-статус в первую очередь. Несуществующая модель при `allowedModels: ["*"]` придёт именно
так — ошибкой OpenRouter, а не `model_not_allowed`.

Правило ретрая на клиенте:
- ретраить **503 / 504 / сетевые** ошибки — экспоненциальный backoff, уважать `Retry-After`;
- при ретрае слать **тот же** `X-Idempotency-Key` и **новый** `X-Request-Id`;
- **не** ретраить 400/401/413 (кроме 429 — там backoff);
- прокси сам делает до 2 upstream-попыток внутри дедлайна, поэтому клиентский ретрай — это
  «внешний» слой на случай `queue_full`/дедлайна.

## 7. Мультитенантность: что изолировано, а что общее

Токен = ваш `clientId`. Прокси мультитенантный.

**Изолировано по клиентам:**
- токен — свой у каждого проекта, его ротация не задевает соседей;
- лимиты конкурентности `maxConcurrency`/`maxPending` — своя очередь;
- политика моделей: `defaultModel`, `allowedModels`, `fallbackModels`;
- журнал и статистика (`client_id`); серия ошибок для алертов считается пер-клиентски;
- дедуп по `X-Idempotency-Key`;
- опционально — свой ключ OpenRouter (биллинговая изоляция).

**Общее для всех:**
- глобальный потолок одновременных upstream-вызовов — под нагрузкой соседи всё ещё могут
  вас притормозить вплоть до `queue_full`;
- серверный дедлайн ~190 с и лимит тела ~26 МБ;
- ключ OpenRouter — если оператор не выдал вам персональный (общий бюджет и биллинг);
- nginx IP-allowlist — общий на `location /api/`, не пер-клиентский: привязки
  «токен X только с IP Y» нет;
- дайджест в Telegram — агрегат по всему прокси, без разбивки.

**Чего нет:** rate limit и дневных квот на клиента (лимит одновременности — это
back-pressure, не throttling); самообслуживания — смена модели/лимитов/IP только через
оператора, реестр читается на старте сервиса.

## 8. Как начать выбирать модель

Для проекта, который **уже подключён** и хочет выбирать модель сам. Доработка кода (шаги
2-5) и включение выбора оператором (шаг 6) независимы и безопасны в любом порядке: пока
`PROXY_LLM_MODEL=proxy`, доработанный клиент ведёт себя ровно как недоработанный.

1. **Проверить, что вы шлёте сейчас.** Найдите в коде, что уходит в поле `model`. Три случая:
   - **реальный слаг** (напр. PassDesk шлёт `OCR_OPENROUTER_MODEL`) — **осторожно**: сейчас
     прокси его игнорирует, но как только оператор включит вам выбор, значение **оживёт** и
     молча изменит роутинг и биллинг, а fallback-цепочка отключится. Сначала шаг 2;
   - **заглушка `"proxy"`** — безопасно, ничего не изменится;
   - **поле не шлётся** — безопасно.
2. **Завести ручку модели в конфиге**, а не хардкодить: `PROXY_LLM_MODEL=proxy`. Значение по
   умолчанию — заглушка, поэтому саму доработку можно выкатывать отдельно и незаметно.
3. **Слать значение ручки в `model`:** `model: process.env.PROXY_LLM_MODEL || 'proxy'`.
4. **Обработать `400 model_not_allowed`** — не ретраить (это конфиг, а не сбой), прочитать
   список из поля `allowed`, залогировать. Пример — §5.2.
5. **Учесть, что явный выбор отключает fallback-цепочку.** Прокси перестаёт подставлять
   `models[]`: недоступна модель — придёт ошибка, а не тихий переезд на резервную. Нужна
   отказоустойчивость — либо не выбирать модель, либо реализовать перебор моделей у себя.
6. **Попросить оператора** включить выбор для вашего `clientId`: `allowedModels: ["*"]`
   (любая модель) или конкретный список, затем рестарт прокси.
7. **Проверить** (§3): `PROXY_LLM_MODEL=proxy` → в ответе дефолтная модель;
   `PROXY_LLM_MODEL=<слаг>` → в ответе он же; заведомо чужой слаг при списке →
   `400 model_not_allowed`.

Откат — вернуть `PROXY_LLM_MODEL=proxy`: без правок кода и без участия оператора.

## 9. Онбординг нового клиента (делает оператор `proxy_llm`)

1. Завести запись в `/etc/proxy_llm/clients.json`: `clientId`, токен (`tokens` или
   `tokenSha256`), при необходимости `defaultModel`, `allowedModels`, `fallbackModels`,
   `maxConcurrency`/`maxPending`, `openrouterApiKey`. Готовые команды на `jq` —
   `docs/vps-update.md` §4.
2. Добавить egress-IP клиента в `location /api/` файла `deploy/nginx/proxy_llm.conf`
   (`allow <IP>;` **перед** `deny all;`), затем `sudo nginx -t && sudo systemctl reload nginx`.
3. `sudo systemctl restart proxy_llm` — именно restart: реестр читается только на старте,
   `ExecReload` не определён.
4. Передать токен по защищённому каналу и **сообщить политику моделей**: `clientId`,
   дефолтную модель и `allowedModels` (пусто / список / `*`) — от этого зависит, может ли
   клиент слать `model`.

Включение выбора модели существующему клиенту — по чек-листу `docs/vps-update.md` §4a:
у клиентов, которые уже шлют реальное имя модели, оно при включении оживёт.

Подробнее: `docs/vps-update.md` (§4 подключение, §4a выбор модели), `docs/operator-guide.md`
(Часть 8 — мультитенантность), `docs/architecture.md` (что прокси делает и не делает).

## 10. Чеклист интеграции

- [ ] `PROXY_LLM_TOKEN` в секретах сервиса, не в коде/репозитории; только HTTPS.
- [ ] `base_url` = `<BASE>/api/v1` (для OpenAI SDK) либо POST на `<BASE>/api/v1/chat/completions`.
- [ ] Знаем свою политику моделей (`allowedModels`: пусто / список / `*`) и дефолтную модель.
- [ ] Модель не выбираем → шлём заглушку `proxy` либо не шлём `model`; произвольной
      строки-«пустышки» в `model` нет.
- [ ] Модель выбираем → она из `allowed`, обрабатывается 400 `model_not_allowed`, и учтено,
      что явный выбор отключает fallback-цепочку.
- [ ] `stream:true` не отправляется.
- [ ] Обрабатываются 503/504 с ретраем и backoff; при ретрае — тот же `X-Idempotency-Key`,
      новый `X-Request-Id`.
- [ ] Ориентация на HTTP-статус (не всякая ошибка имеет `{error:{code}}`).
- [ ] Вызовы только server-to-server (не из браузера).
- [ ] Оператор добавил egress-IP клиента в nginx-allowlist (§9).

## Проверка перед сдачей интеграции

Прогнать против прокси (дев: `npm run dev` → `http://127.0.0.1:3000`, прод — свой домен):

1. `GET /healthz` → `200 {"status":"ok"}`.
2. `POST /api/v1/chat/completions` с корректным Bearer и `messages` → `200`, OpenAI-тело,
   в заголовках ответа есть `x-proxy-request-id`.
3. Тот же запрос без/с неверным токеном → `401 unauthorized`.
4. Тело с `"stream": true` → `400 streaming_not_supported`.
5. `{"model":"proxy", …}` → `200`, в теле ответа `model` = дефолтная модель клиента
   (заглушка не ушла в роутинг).
6. (если выбор разрешён) `model` из вашего `allowed` → `200`, в ответе `model` = запрошенная.
7. (если `allowedModels` — список) заведомо чужая модель → `400 model_not_allowed`,
   в теле — `allowed`.
8. Примеры Python/Node запускаются после подстановки `PROXY_LLM_BASE_URL` / `PROXY_LLM_TOKEN`.
9. (Прод) убедиться, что egress-IP сервиса в allowlist — иначе запрос не дойдёт до токена.

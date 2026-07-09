---
name: connect-proxy-llm
description: Подключение стороннего проекта/модели к LLM-прокси proxy_llm (OpenAI-совместимый POST /api/v1/chat/completions) по одному общему Bearer-токену. Использовать при интеграции или отладке сервиса, которому нужен LLM-вызов через центральный прокси, а не напрямую в OpenRouter/OpenAI. Учитывает ограничения прокси: модель фиксируется сервером, стриминг запрещён, последовательная очередь, IP-allowlist.
---

# Подключение проекта к LLM-прокси `proxy_llm`

`proxy_llm` — центральный прокси между вашим сервисом и OpenRouter. Он прячет реальный
ключ OpenRouter, ведёт журнал вызовов, шлёт алерты и навязывает единую модель.
Для клиента это **OpenAI-совместимый Chat Completions API**: любой OpenAI-клиент
подключается сменой `base_url` и `api_key`, без переписывания логики.

**Скилл переносимый.** Скопируйте каталог `connect-proxy-llm/` в `.claude/skills/`
вашего проекта — инструкции самодостаточны (кроме раздела 8 «Онбординг», он для
оператора прокси).

## 0. Что нужно до старта

Получить у **оператора proxy_llm**:

1. **Базовый URL** — прод обычно `https://<proxy-domain>` (напр. `https://proxy.example.com`),
   локально/дев — `http://127.0.0.1:3000`.
2. **Общий токен** — значение `PROXY_INBOUND_TOKEN` (случайный 32-байт hex). Один и тот
   же токен на все проекты. Хранить в секрете сервиса (env/secret-storage), **не в коде и
   не в репозитории**, передавать только по HTTPS/защищённому каналу.
3. **Какая модель сейчас активна** — вы её не выбираете (см. §1), но знать полезно.
4. Попросить оператора **добавить egress-IP вашего сервиса в nginx-allowlist** — иначе
   прокси вернёт вам отказ ещё до токена (см. §8). Это обязательный шаг для прода.

Клиентские env-переменные (имена — на ваш вкус, здесь по всему скиллу используются):

```env
PROXY_LLM_BASE_URL=https://proxy.example.com
PROXY_LLM_TOKEN=<значение PROXY_INBOUND_TOKEN>
```

## 1. Как устроен прокси и ключевые ограничения

Прочитайте до интеграции — прокси намеренно отличается от прямого OpenAI/OpenRouter:

- **Один эндпоинт:** `POST /api/v1/chat/completions` (легаси-алиас `POST /v1/chat/completions`,
  идентичен). Эндпоинта `/v1/models` **нет**, Anthropic `/v1/messages` **нет**.
- **Модель: по умолчанию задаёт сервер; выбор — если оператор разрешил.** Если у вашего
  клиента в реестре задан белый список моделей (`allowedModels`) — можете прислать `model`
  из этого списка. Если пришлёте модель не из списка → **400 `model_not_allowed`** (в теле
  вернётся `allowed`). Если `model` не прислан или ваш список пуст (legacy) → используется
  дефолтная модель клиента/сервера. Уточните у оператора, какие модели вам разрешены;
  если выбор не нужен — не шлите `model` (или шлите заглушку, она будет проигнорирована при
  пустом списке).
- **Стриминг запрещён.** `"stream": true` → **HTTP 400** `streaming_not_supported`.
  Только non-streaming запрос/ответ.
- **Молча вырезаются** из тела: `provider`, `route`, `transforms`, `plugins`,
  `stream_options`, `debug` (это защита от обхода серверного роутинга/провайдера).
- **Дедлайн запроса** ~190 с (`REQUEST_DEADLINE_MS`) → при исчерпании **504** `deadline_exceeded`.
- **Лимит тела запроса** ~26 МБ → **413** `payload_too_large`.
- **Ограничение конкурентности.** Есть общий потолок одновременных вызовов и (при
  мультитенантной настройке) пер-клиентский лимит. Переполнение → **503** `queue_full`
  + `Retry-After: 10`. Обрабатывайте ретраем с backoff (см. §6).
- **Только server-to-server.** CORS не настроен — **из браузера не вызывать**.
- **Ответ** — стандартный OpenAI JSON (`id`, `model`, `choices`, `usage`), плюс заголовки
  `x-proxy-request-id` (id запроса в прокси) и `x-openrouter-request-id` (upstream `gen-…`
  для биллинг-сверки).

## 2. Аутентификация

Каждый запрос предъявляет общий токен в заголовке:

```
Authorization: Bearer <PROXY_LLM_TOKEN>
```

Токен один на все проекты. Отсутствует/неверный → **401** `unauthorized`. Проверка идёт
до чтения тела.

## 3. Быстрые проверки (curl)

```bash
BASE=https://proxy.example.com
TOKEN=<ваш-токен>

# Публичный liveness (без токена)
curl -s "$BASE/healthz"                    # -> {"status":"ok"}

# Минимальный вызов. model можно не слать (или прислать любую — игнорируется).
curl -s "$BASE/api/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Request-Id: $(uuidgen)" \
  -d '{"messages":[{"role":"user","content":"ping"}]}'
# -> OpenAI-ответ: {"id":...,"model":...,"choices":[...],"usage":{...}}
#    заголовки ответа: x-proxy-request-id, x-openrouter-request-id

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
    api_key=os.environ["PROXY_LLM_TOKEN"],   # общий токен прокси
)

resp = client.chat.completions.create(
    model="proxy",                            # заглушка: реальную модель выбирает сервер
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

def chat(messages, idempotency_key=None):
    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
        "X-Request-Id": str(uuid.uuid4()),          # новый на каждую попытку
    }
    if idempotency_key:
        headers["X-Idempotency-Key"] = idempotency_key  # стабильный на задачу
    r = requests.post(f"{BASE}/api/v1/chat/completions",
                      headers=headers, json={"messages": messages}, timeout=200)
    if r.status_code >= 400:
        body = r.json() if "application/json" in r.headers.get("content-type", "") else {}
        code = (body.get("error") or {}).get("code", "")
        raise RuntimeError(f"{r.status_code} {code}: {r.text[:300]}")
    return r.json()
```

### 5.3 Node/TypeScript — OpenAI SDK

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: `${process.env.PROXY_LLM_BASE_URL}/api/v1`,
  apiKey: process.env.PROXY_LLM_TOKEN,       // общий токен прокси
});

const resp = await client.chat.completions.create({
  model: 'proxy',                            // заглушка: модель выбирает сервер
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
              private token = process.env.PROXY_LLM_TOKEN!) {}

  // { status, body } — чтобы вызывающий код различал 503 queue_full / 504 от прочего.
  async chat(messages: unknown[], idempotencyKey?: string): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      'X-Request-Id': crypto.randomUUID(),            // новый на каждую попытку
    };
    if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey; // стабильный на задачу
    const res = await fetch(`${this.base}/api/v1/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify({ messages }),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }
}
```

Все примеры читают `PROXY_LLM_BASE_URL` / `PROXY_LLM_TOKEN` из окружения — токен в коде не
хардкодить.

## 6. Ошибки и ретраи

Тело ошибки, сгенерированной **прокси**: `{ "error": { "code": "...", "message": "..." } }`.

| код | HTTP | причина | что делать |
|---|---|---|---|
| `unauthorized` | 401 | нет/неверный Bearer | проверить токен |
| `invalid_request` | 400 | тело не JSON-объект или `messages` пустой/не массив | исправить тело |
| `streaming_not_supported` | 400 | прислан `stream:true` | убрать `stream` |
| `model_not_allowed` | 400 | `model` не входит в разрешённый вам список (`allowed` в теле) | взять модель из `allowed` или не слать `model` |
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
HTTP-статус в первую очередь.

Правило ретрая на клиенте:
- ретраить **503 / 504 / сетевые** ошибки — экспоненциальный backoff, уважать `Retry-After`;
- при ретрае слать **тот же** `X-Idempotency-Key` и **новый** `X-Request-Id`;
- **не** ретраить 400/401/413 (кроме 429 — там backoff);
- прокси сам делает до 2 upstream-попыток внутри дедлайна, поэтому клиентский ретрай — это
  «внешний» слой на случай `queue_full`/дедлайна.

## 7. Ограничения модели «один токен на всех»

Осознанно принимаемые компромиссы общего токена:

- Все проекты делят **одну модель** (серверную) и **один серверный дедлайн**.
- Все проекты делят **одну последовательную очередь** (`concurrency=1`) — под нагрузкой
  взаимно тормозят и могут ловить `queue_full`.
- Токен = **полный доступ к LLM-бюджету**; его ротация затрагивает все проекты разом.
- Каждый новый egress-IP клиента должен быть в nginx-allowlist (см. §8).

Если проектов много, у них динамические IP, или нужна изоляция моделей/лимитов/биллинга по
клиентам — это выходит за рамки текущего однотенантного дизайна прокси (потребует доработки
на стороне `proxy_llm`; в этот скилл не входит).

## 8. Онбординг нового клиента (делает оператор `proxy_llm`)

Чтобы новый проект реально дошёл до прокси:

1. Добавить egress-IP клиента в блок `location /api/` файла `deploy/nginx/proxy_llm.conf`
   (строку `allow <IP>;` **перед** `deny all;`), затем `sudo nginx -t && sudo systemctl reload nginx`.
2. Передать значение `PROXY_INBOUND_TOKEN` по защищённому каналу.
3. Сообщить, какая модель сейчас активна (`OPENROUTER_MODEL`).

Подробнее: `docs/operator-guide.md` (Part 3 — выдача токена PassDesk, применимо и к другим
клиентам), `docs/architecture.md` (что прокси делает и не делает).

## 9. Чеклист интеграции

- [ ] `PROXY_LLM_TOKEN` в секретах сервиса, не в коде/репозитории; только HTTPS.
- [ ] `base_url` = `<BASE>/api/v1` (для OpenAI SDK) либо POST на `<BASE>/api/v1/chat/completions`.
- [ ] `model` — заглушка, на выбор модели не полагаемся.
- [ ] `stream:true` не отправляется.
- [ ] Обрабатываются 503/504 с ретраем и backoff; при ретрае — тот же `X-Idempotency-Key`,
      новый `X-Request-Id`.
- [ ] Ориентация на HTTP-статус (не всякая ошибка имеет `{error:{code}}`).
- [ ] Вызовы только server-to-server (не из браузера).
- [ ] Оператор добавил egress-IP клиента в nginx-allowlist (§8).

## Проверка перед сдачей интеграции

Прогнать против прокси (дев: `npm run dev` → `http://127.0.0.1:3000`, прод — свой домен):

1. `GET /healthz` → `200 {"status":"ok"}`.
2. `POST /api/v1/chat/completions` с корректным Bearer и `messages` → `200`, OpenAI-тело,
   в заголовках ответа есть `x-proxy-request-id`.
3. Тот же запрос без/с неверным токеном → `401 unauthorized`.
4. Тело с `"stream": true` → `400 streaming_not_supported`.
5. Примеры Python/Node запускаются после подстановки `PROXY_LLM_BASE_URL` / `PROXY_LLM_TOKEN`.
6. (Прод) убедиться, что egress-IP сервиса в allowlist — иначе запрос не дойдёт до токена.

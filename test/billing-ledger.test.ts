import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, type MockServer } from './helpers/mock-openrouter.js';

const token = 'billing-tok-1234567890';

interface AttemptRow {
  execution_id: string;
  attempt_no: number;
  client_id: string | null;
  payer_scope: string;
  api_key_fp: string | null;
  billing_day: string;
  model_used: string | null;
  upstream_id: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd: number | null;
  usage_source: string;
  classification: string;
  usage_json: string | null;
}

function attempts(bundle: AppBundle): AttemptRow[] {
  return bundle.db.db
    .prepare('SELECT * FROM billing_attempts ORDER BY id')
    .all() as unknown as AttemptRow[];
}

function requestRows(bundle: AppBundle): { billing_execution_id: string | null; dedup_join: number }[] {
  return bundle.db.db
    .prepare('SELECT billing_execution_id, dedup_join FROM requests ORDER BY id')
    .all() as { billing_execution_id: string | null; dedup_join: number }[];
}

function bodyWithUsage(usage: Record<string, unknown>, model = 'mock/model'): Record<string, unknown> {
  return {
    id: 'gen-' + Math.random().toString(36).slice(2),
    model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    usage,
  };
}

async function withApp(
  handler: Parameters<typeof startMockOpenRouter>[0],
  fn: (bundle: AppBundle, upstream: MockServer) => Promise<void>,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const upstream = await startMockOpenRouter(handler);
  const bundle = await buildApp(
    makeTestConfig({
      OPENROUTER_BASE_URL: upstream.baseUrl,
      PROXY_INBOUND_TOKEN: token,
      ...overrides,
    }),
  );
  try {
    await fn(bundle, upstream);
  } finally {
    await bundle.app.close();
    bundle.db.close();
    bundle.stopWatchdog();
    bundle.stopDigest();
    await upstream.close();
  }
}

const post = (bundle: AppBundle, headers: Record<string, string> = {}) =>
  bundle.app.inject({
    method: 'POST',
    url: '/api/v1/chat/completions',
    headers: { authorization: `Bearer ${token}`, ...headers },
    payload: { messages: [{ role: 'user', content: 'doc' }] },
  });

describe('billing ledger: capturing actual cost', () => {
  it('records usage.cost and token details from the response', async () => {
    await withApp(
      (_req, res) =>
        jsonResponse(
          res,
          200,
          bodyWithUsage({
            prompt_tokens: 1200,
            completion_tokens: 340,
            total_tokens: 1540,
            cost: 0.0021,
            cost_details: { upstream_inference_cost: 0.002 },
            prompt_tokens_details: { cached_tokens: 800 },
            completion_tokens_details: { reasoning_tokens: 120 },
          }),
        ),
      async (bundle) => {
        const res = await post(bundle);
        expect(res.statusCode).toBe(200);

        const rows = attempts(bundle);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          attempt_no: 1,
          client_id: 'passdesk',
          payer_scope: 'global',
          prompt_tokens: 1200,
          completion_tokens: 340,
          cached_tokens: 800,
          reasoning_tokens: 120,
          cost_usd: 0.0021,
          usage_source: 'response',
          classification: 'success',
        });
        expect(rows[0]?.upstream_id).toMatch(/^gen-/);
        expect(rows[0]?.api_key_fp).toHaveLength(16);
        expect(rows[0]?.billing_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(JSON.parse(rows[0]!.usage_json!)).toMatchObject({ cost: 0.0021 });
      },
    );
  });

  it('marks an attempt as missing when the response carries no cost', async () => {
    await withApp(
      (_req, res) =>
        jsonResponse(res, 200, bodyWithUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })),
      async (bundle) => {
        await post(bundle);
        const rows = attempts(bundle);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.cost_usd).toBeNull();
        expect(rows[0]?.usage_source).toBe('missing');
        expect(rows[0]?.prompt_tokens).toBe(10);
      },
    );
  });

  // Ключевой сценарий: ретрай после ОПЛАЧЕННОЙ попытки. Раньше в журнал попадали токены
  // только последней попытки — оплаченный ретрай выпадал из расхода клиента целиком.
  it('keeps both paid attempts with their own tokens, models and generation ids', async () => {
    let n = 0;
    await withApp(
      (_req, res) => {
        n += 1;
        if (n === 1) {
          // 200 с ошибкой в теле: retryable, но генерация уже оплачена.
          jsonResponse(res, 200, {
            id: 'gen-first-paid',
            model: 'mock/model-a',
            choices: [{ index: 0, finish_reason: 'error', message: { role: 'assistant', content: '' } }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.001 },
          });
          return;
        }
        jsonResponse(
          res,
          200,
          bodyWithUsage(
            { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cost: 0.004 },
            'mock/model-b',
          ),
        );
      },
      async (bundle) => {
        const res = await post(bundle);
        expect(res.statusCode).toBe(200);

        const rows = attempts(bundle);
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.attempt_no)).toEqual([1, 2]);
        expect(rows[0]?.model_used).toBe('mock/model-a');
        expect(rows[1]?.model_used).toBe('mock/model-b');
        expect(rows[0]?.upstream_id).not.toBe(rows[1]?.upstream_id);

        // Обе попытки оплачены — в расход входят обе.
        const totalCost = rows.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
        expect(totalCost).toBeCloseTo(0.005, 12);
        const totalOut = rows.reduce((s, r) => s + (r.completion_tokens ?? 0), 0);
        expect(totalOut).toBe(60);

        // Одно выполнение, один HTTP-запрос клиента.
        expect(new Set(rows.map((r) => r.execution_id)).size).toBe(1);
        expect(requestRows(bundle)).toHaveLength(1);
      },
    );
  });

  it('records an attempt with usage_source=missing when the body never parses', async () => {
    await withApp(
      (_req, res) => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.destroy(); // обрыв: тело не разобрано, генерация могла быть оплачена
      },
      async (bundle) => {
        await post(bundle);
        const rows = attempts(bundle);
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows.every((r) => r.usage_source === 'missing')).toBe(true);
        expect(rows.every((r) => r.cost_usd === null)).toBe(true);
      },
    );
  });
});

describe('billing ledger: dedup join is not a second charge', () => {
  // Регресс: persistRecord вызывается для КАЖДОГО HTTP-запроса, поэтому join давал вторую
  // строку с теми же токенами. В деньгах это было бы прямым завышением расхода.
  it('two joined requests → two request rows, one execution, one set of attempts', async () => {
    await withApp(
      async (_req, res) => {
        await new Promise((r) => setTimeout(r, 300));
        jsonResponse(
          res,
          200,
          bodyWithUsage({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.003 }),
        );
      },
      async (bundle, upstream) => {
        const headers = { 'x-idempotency-key': 'job-shared-1' };
        const [r1, r2] = await Promise.all([post(bundle, headers), post(bundle, headers)]);
        expect(r1.statusCode).toBe(200);
        expect(r2.statusCode).toBe(200);
        expect(upstream.requests).toHaveLength(1);

        const rows = attempts(bundle);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.cost_usd).toBe(0.003);

        // Оба HTTP-запроса видны и оба ссылаются на одно выполнение; помечен ровно один join.
        const reqs = requestRows(bundle);
        expect(reqs).toHaveLength(2);
        expect(new Set(reqs.map((r) => r.billing_execution_id)).size).toBe(1);
        expect(reqs.filter((r) => r.dedup_join === 1)).toHaveLength(1);

        // Итог расхода — одинарный, несмотря на два запроса клиента.
        const spent = bundle.db.db
          .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM billing_attempts')
          .get() as { s: number };
        expect(spent.s).toBeCloseTo(0.003, 12);
      },
      { QUEUE_CONCURRENCY: 2 },
    );
  });
});

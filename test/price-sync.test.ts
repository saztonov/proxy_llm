import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/storage/db.js';
import { BillingRepo } from '../src/storage/billing-repo.js';
import { runPriceSync } from '../src/billing/price-sync.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, type MockServer } from './helpers/mock-openrouter.js';
import { logger } from '../src/utils/logger.js';

function modelsBody(models: { id: string; pricing: Record<string, unknown> }[]): Record<string, unknown> {
  return { data: models.map((m) => ({ id: m.id, name: m.id, pricing: m.pricing })) };
}

const GEMINI = {
  id: 'google/gemini-3.1-flash-lite',
  pricing: { prompt: '0.0000001', completion: '0.0000004', input_cache_read: '0.000000025' },
};

describe('price sync', () => {
  let dir: string;
  let handle: DbHandle;
  let billing: BillingRepo;
  let upstream: MockServer | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proxy_llm-prices-'));
    handle = openDb(join(dir, 'test.db'));
    billing = new BillingRepo(handle.db);
  });

  afterEach(async () => {
    handle.close();
    if (upstream) await upstream.close();
    upstream = null;
    rmSync(dir, { recursive: true, force: true });
  });

  const deps = (base: string) => ({
    config: makeTestConfig({ OPENROUTER_BASE_URL: base }),
    billing,
    logger,
  });

  it('stores a version per model and logs a successful run', async () => {
    upstream = await startMockOpenRouter((req, res) => {
      expect(req.url).toContain('/api/v1/models');
      jsonResponse(res, 200, modelsBody([GEMINI, { id: 'openai/gpt-5.6-luna', pricing: { prompt: '0.000001', completion: '0.000006' } }]));
    });

    const r = await runPriceSync(deps(upstream.baseUrl));
    expect(r.ok).toBe(true);
    expect(r.modelsSeen).toBe(2);
    expect(r.versionsWritten).toBe(2);

    const v = billing.latestPriceVersion(GEMINI.id);
    expect(v?.price_prompt).toBe('0.0000001');
    expect(v?.price_cache_read).toBe('0.000000025');
    expect(v?.has_sentinel).toBe(0);
    expect(billing.hasSuccessfulSyncForDay(r.day)).toBe(true);
  });

  it('writes a new version only when pricing actually changes', async () => {
    let pricing: Record<string, unknown> = { prompt: '0.0000001', completion: '0.0000004' };
    upstream = await startMockOpenRouter((_req, res) => {
      jsonResponse(res, 200, modelsBody([{ id: GEMINI.id, pricing }]));
    });
    const d = deps(upstream.baseUrl);

    expect((await runPriceSync(d)).versionsWritten).toBe(1);
    // Тот же прайс, другой порядок ключей — не считается изменением.
    pricing = { completion: '0.0000004', prompt: '0.0000001' };
    expect((await runPriceSync(d)).versionsWritten).toBe(0);
    // Реальное изменение цены — новая версия.
    pricing = { prompt: '0.0000002', completion: '0.0000004' };
    expect((await runPriceSync(d)).versionsWritten).toBe(1);

    const rows = handle.db
      .prepare('SELECT price_prompt FROM model_price_versions WHERE model_id = ? ORDER BY id')
      .all(GEMINI.id) as { price_prompt: string }[];
    expect(rows.map((r) => r.price_prompt)).toEqual(['0.0000001', '0.0000002']);
  });

  it('flags sentinel prices and tiered overrides', async () => {
    upstream = await startMockOpenRouter((_req, res) => {
      jsonResponse(
        res,
        200,
        modelsBody([
          { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
          {
            id: 'tiered/model',
            pricing: {
              prompt: '0.000001',
              completion: '0.000002',
              overrides: [{ min_prompt_tokens: 272000, prompt: '0.000002' }],
            },
          },
        ]),
      );
    });

    await runPriceSync(deps(upstream.baseUrl));
    expect(billing.latestPriceVersion('openrouter/auto')?.has_sentinel).toBe(1);
    expect(billing.latestPriceVersion('tiered/model')?.has_overrides).toBe(1);
  });

  it('skips malformed entries but keeps the rest', async () => {
    upstream = await startMockOpenRouter((_req, res) => {
      jsonResponse(res, 200, {
        data: [
          { id: 123, pricing: { prompt: '0.1' } }, // id не строка
          { name: 'no id' },
          'garbage',
          { id: 'no/pricing' }, // без pricing — цену взять неоткуда
          { id: GEMINI.id, pricing: GEMINI.pricing },
        ],
      });
    });

    const r = await runPriceSync(deps(upstream.baseUrl));
    expect(r.ok).toBe(true);
    expect(r.modelsSeen).toBe(1);
    expect(billing.latestPriceVersion(GEMINI.id)).not.toBeNull();
  });

  it('retries without Authorization when the catalog answers 401', async () => {
    const auths: (string | undefined)[] = [];
    upstream = await startMockOpenRouter((req, res) => {
      const auth = req.headers.authorization as string | undefined;
      auths.push(auth);
      if (auth) {
        jsonResponse(res, 401, { error: 'no auth for you' });
        return;
      }
      jsonResponse(res, 200, modelsBody([GEMINI]));
    });

    const r = await runPriceSync(deps(upstream.baseUrl));
    expect(r.ok).toBe(true);
    expect(auths).toHaveLength(2);
    expect(auths[0]).toMatch(/^Bearer /);
    expect(auths[1]).toBeUndefined();
  });

  it('records a failed run without throwing on 500', async () => {
    upstream = await startMockOpenRouter((_req, res) => jsonResponse(res, 500, { error: 'boom' }));

    const r = await runPriceSync(deps(upstream.baseUrl));
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(500);
    expect(billing.hasSuccessfulSyncForDay(r.day)).toBe(false);

    const runs = handle.db.prepare('SELECT ok, error FROM price_sync_runs').all() as {
      ok: number;
      error: string | null;
    }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.ok).toBe(0);
    expect(runs[0]?.error).toContain('500');
  });

  it('records a failed run when the catalog is unreachable', async () => {
    const r = await runPriceSync(deps('http://127.0.0.1:1'));
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBeNull();
    expect(billing.lastSuccessfulSync()).toBeNull();
  });

  it('resolves the price in effect at a given moment', async () => {
    let pricing: Record<string, unknown> = { prompt: '0.0000001', completion: '0.0000004' };
    upstream = await startMockOpenRouter((_req, res) => {
      jsonResponse(res, 200, modelsBody([{ id: GEMINI.id, pricing }]));
    });
    const base = upstream.baseUrl;

    const t1 = Date.parse('2026-07-01T06:00:00.000Z');
    await runPriceSync({ ...deps(base), now: () => t1 });
    pricing = { prompt: '0.0000005', completion: '0.0000004' };
    const t2 = Date.parse('2026-07-10T06:00:00.000Z');
    await runPriceSync({ ...deps(base), now: () => t2 });

    // Запрос из 5 июля должен оцениваться по старой цене, из 15-го — по новой.
    expect(billing.priceVersionAt(GEMINI.id, Date.parse('2026-07-05T12:00:00Z'))?.price_prompt).toBe('0.0000001');
    expect(billing.priceVersionAt(GEMINI.id, Date.parse('2026-07-15T12:00:00Z'))?.price_prompt).toBe('0.0000005');
    // До первого наблюдения цены нет — оценивать нечем, и это честнее выдумывания.
    expect(billing.priceVersionAt(GEMINI.id, Date.parse('2026-06-01T12:00:00Z'))).toBeNull();
  });
});

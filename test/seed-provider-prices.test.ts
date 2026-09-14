import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { attemptRecord } from './helpers/records.js';
import { seedAdmin, loginAs, adminCall } from './helpers/admin-session.js';
import { seedKnownProviderPrices } from '../src/billing/seed-provider-prices.js';
import { logger } from '../src/utils/logger.js';

const SAT = Date.UTC(2026, 8, 12, 15, 0); // суббота: весь день вне пика
const MON_PEAK = Date.UTC(2026, 8, 14, 7, 0); // понедельник 07:00 UTC — пик

describe('built-in DeepSeek prices', () => {
  let b: AppBundle;
  const seed = (only?: number) => seedKnownProviderPrices({ db: b.db.db, repos: b.repos, logger }, only);
  const addProvider = (name: string, baseUrl: string) => b.repos.providers.create({
    name, base_url: baseUrl, api_key_enc: null, api_key_fp: null, extra_headers_enc: null, usage_mode: 'auto', max_concurrency: null,
  }, Date.now());
  const attempt = (providerId: number, ts: number) => b.repos.billing.insertAttempt(attemptRecord({
    contour: 'agent', provider_id: providerId, model_requested: 'deepseek-flash', model_used: 'deepseek-flash',
    ts_started: ts, usage_source: 'missing', cost_usd: null, cost_est_usd: null, est_quality: 'no_price',
    prompt_tokens: 1_000_000, cached_tokens: 900_000, completion_tokens: 1_000_000,
  }));
  const estimates = () => (b.db.db.prepare('SELECT cost_est_usd FROM billing_attempts ORDER BY id').all() as Array<{ cost_est_usd: number | null }>)
    .map((r) => r.cost_est_usd);

  beforeEach(async () => {
    b = await buildApp(makeTestConfig());
  });
  afterEach(async () => {
    await b.app.close();
    b.db.close();
    b.stopTickers();
  });

  it('fills DeepSeek models once, reprices past requests by peak and off-peak tariff', () => {
    const ds = addProvider('deepseek', 'https://api.deepseek.com');
    const other = addProvider('other', 'https://llm.example.com/v1');
    attempt(ds, SAT);
    attempt(ds, MON_PEAK);

    expect(seed()).toBe(4);
    expect(b.repos.providerPrices.listLatest(ds).map((v) => v.model)).toEqual([
      'deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro',
    ]);
    expect(b.repos.providerPrices.listLatest(other)).toEqual([]);
    const [offPeak, peak] = estimates();
    expect(offPeak).toBeCloseTo(0.015 + 0.0027 + 0.6, 10);
    expect(peak).toBeCloseTo(0.03 + 0.0054 + 1.2, 10);

    // Удалённая админом цена при следующем старте не возвращается.
    b.repos.providerPrices.deleteModel(ds, 'deepseek-v4-pro');
    expect(seed()).toBe(0);
    expect(b.repos.providerPrices.listLatest(ds)).toHaveLength(3);
  });

  it('keeps a price the admin already entered for a model', () => {
    const ds = addProvider('deepseek', 'https://api.deepseek.com/v1');
    b.repos.providerPrices.insert({ provider_id: ds, model: 'deepseek-flash', effective_from: 0, price: { input: 9, output: 9 }, created_by: null }, Date.now());
    expect(seed()).toBe(3);
    expect(b.repos.providerPrices.priceAt(ds, 'deepseek-flash', Date.now())!.price).toEqual({ input: 9, output: 9 });
  });

  it('a DeepSeek provider created in the admin gets prices right away', async () => {
    await seedAdmin(b);
    const s = await loginAs(b);
    const created = await adminCall(b, s, 'POST', '/admin/api/providers', { name: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-deepseek-test-1' });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { provider: { id: number } }).provider.id;
    const prices = await adminCall(b, s, 'GET', `/admin/api/providers/${id}/prices`);
    expect((prices.json() as { prices: Array<{ model: string }> }).prices.map((p) => p.model)).toContain('deepseek-flash');
  });
});

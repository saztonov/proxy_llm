import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, type MockServer } from './helpers/mock-openrouter.js';
import { seedAgent, type Seeded } from './helpers/agent-seed.js';
import { seedAdmin, loginAs, adminCall, type AdminSession } from './helpers/admin-session.js';

const MODEL = 'deepseek-flash';
/** Ответ как у DeepSeek: только токены, без usage.cost. */
const deepseekBody = {
  id: 'chatcmpl-ds', object: 'chat.completion', created: 1, model: MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 900_000 } },
};
const PRICE = { input: 0.3, cacheRead: 0.006, output: 1.2 };
const EXPECTED = 0.03 + 0.0054 + 1.2;

type Row = { cost_est_usd: number | null; est_quality: string | null; est_provider_price_id: number | null; usage_source: string };

describe('provider model prices: estimate for providers that report tokens only', () => {
  let up: MockServer;
  let b: AppBundle;
  let seeded: Seeded;
  let admin: AdminSession;

  beforeEach(async () => {
    up = await startMockOpenRouter((_q, res) => jsonResponse(res, 200, deepseekBody));
    b = await buildApp(makeTestConfig({ OPENROUTER_BASE_URL: up.baseUrl }));
    seeded = seedAgent(b, { baseUrl: `${up.baseUrl}/v1`, model: MODEL });
    await seedAdmin(b);
    admin = await loginAs(b);
  });
  afterEach(async () => {
    await b.app.close();
    b.db.close();
    b.stopTickers();
    await up.close();
  });

  const ask = () => b.app.inject({
    method: 'POST', url: '/agent/v1/chat/completions',
    headers: { authorization: `Bearer ${seeded.token}` },
    payload: { messages: [{ role: 'user', content: 'hi' }] },
  });
  const rows = () => b.db.db.prepare('SELECT cost_est_usd, est_quality, est_provider_price_id, usage_source FROM billing_attempts ORDER BY id').all() as Row[];
  const pricesUrl = () => `/admin/api/providers/${seeded.providerId}/prices`;
  const today = () => new Date().toISOString().slice(0, 10);

  it('without a price the attempt stays without cost; setting one reprices the past', async () => {
    expect((await ask()).statusCode).toBe(200);
    expect(rows()).toEqual([{ cost_est_usd: null, est_quality: 'no_price', est_provider_price_id: null, usage_source: 'missing' }]);

    const set = await adminCall(b, admin, 'POST', pricesUrl(), { model: MODEL, price: PRICE });
    expect(set.statusCode).toBe(201);
    expect(set.json()).toMatchObject({ recalculated: 1, price: { model: MODEL, effectiveFrom: 0, price: PRICE } });
    const [past] = rows();
    expect(past!.cost_est_usd).toBeCloseTo(EXPECTED, 10);
    expect(past!.est_quality).toBe('ok');

    // Отчёты: оценка идёт колонкой «≈», факт не трогается.
    const totals = b.repos.billing.spendTotals(today(), today(), 'agent');
    expect(totals.cost_actual_usd).toBe(0);
    expect(totals.cost_approx_usd).toBeCloseTo(EXPECTED, 10);
    expect(totals.missing_rows).toBe(0);
  });

  it('new requests are priced on arrival; a future price version does not touch them', async () => {
    await adminCall(b, admin, 'POST', pricesUrl(), { model: MODEL, price: PRICE });
    await ask();
    const [row] = rows();
    expect(row!.cost_est_usd).toBeCloseTo(EXPECTED, 10);
    expect(row!.est_provider_price_id).not.toBeNull();

    const later = await adminCall(b, admin, 'POST', pricesUrl(), { model: MODEL, effectiveFrom: Date.now() + 3_600_000, price: { input: 9, output: 9 } });
    expect(later.json()).toMatchObject({ recalculated: 0 });
    expect(rows()[0]!.cost_est_usd).toBeCloseTo(EXPECTED, 10);

    const list = await adminCall(b, admin, 'GET', pricesUrl());
    expect(list.json().prices).toEqual([expect.objectContaining({ model: MODEL, price: { input: 9, output: 9 } })]);
  });

  it('deleting the price removes the estimate; invalid prices are rejected', async () => {
    await adminCall(b, admin, 'POST', pricesUrl(), { model: MODEL, price: PRICE });
    await ask();
    const del = await adminCall(b, admin, 'DELETE', `${pricesUrl()}?model=${MODEL}`);
    expect(del.json()).toEqual({ deleted: 1, recalculated: 1 });
    expect(rows()[0]).toMatchObject({ cost_est_usd: null, est_quality: 'no_price', est_provider_price_id: null });
    expect((await adminCall(b, admin, 'DELETE', `${pricesUrl()}?model=${MODEL}`)).statusCode).toBe(404);

    const bad = await adminCall(b, admin, 'POST', pricesUrl(), { model: MODEL, price: { ...PRICE, offPeak: { input: 1, output: 1 } } });
    expect(bad.statusCode).toBe(400);

    const audit = b.db.db.prepare(`SELECT action, details_json FROM admin_audit_log WHERE action LIKE 'provider.price_%' ORDER BY id`).all() as Array<{ action: string; details_json: string }>;
    expect(audit.map((a) => a.action)).toEqual(['provider.price_set', 'provider.price_delete']);
    expect(JSON.parse(audit[0]!.details_json)).toMatchObject({ model: MODEL, effectiveFrom: 0, recalculated: 0 });
  });
});

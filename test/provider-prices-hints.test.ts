import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, type MockServer } from './helpers/mock-openrouter.js';
import { seedAgent, type Seeded } from './helpers/agent-seed.js';
import { seedAdmin, loginAs, adminCall, type AdminSession } from './helpers/admin-session.js';

const MODEL = 'deepseek-flash';
const body = {
  id: 'chatcmpl-ds', object: 'chat.completion', created: 1, model: MODEL,
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 900_000 } },
};
const PRICE = { input: 0.3, cacheRead: 0.006, output: 1.2 };

describe('provider prices: typo guard and cost on the requests page', () => {
  let up: MockServer;
  let b: AppBundle;
  let seeded: Seeded;
  let admin: AdminSession;

  beforeEach(async () => {
    up = await startMockOpenRouter((_q, res) => jsonResponse(res, 200, body));
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

  const pricesUrl = () => `/admin/api/providers/${seeded.providerId}/prices`;
  const ask = () => b.app.inject({
    method: 'POST', url: '/agent/v1/chat/completions',
    headers: { authorization: `Bearer ${seeded.token}` },
    payload: { messages: [{ role: 'user', content: 'hi' }] },
  });
  const lastRequest = async () => ((await adminCall(b, admin, 'GET', '/admin/api/requests?contour=agent&limit=1')).json() as {
    requests: Array<{ cost_actual_usd: number | null; cost_approx_usd: number | null }>;
  }).requests[0]!;

  it('lists models in use and flags a price saved under an unknown name', async () => {
    expect((await adminCall(b, admin, 'GET', pricesUrl())).json()).toMatchObject({ usedModels: [MODEL] });

    const typo = await adminCall(b, admin, 'POST', pricesUrl(), { model: 'deepseel-flash', price: PRICE });
    expect(typo.statusCode).toBe(201);
    expect(typo.json()).toMatchObject({ unusedModel: true, recalculated: 0 });

    const right = await adminCall(b, admin, 'POST', pricesUrl(), { model: MODEL, price: PRICE });
    expect(right.json()).toMatchObject({ unusedModel: false });
  });

  it('the requests page shows the estimate where the provider reports no cost', async () => {
    await ask();
    expect(await lastRequest()).toMatchObject({ cost_approx_usd: null });

    await adminCall(b, admin, 'POST', pricesUrl(), { model: MODEL, price: PRICE });
    const row = await lastRequest();
    expect(row.cost_actual_usd).toBe(0);
    expect(row.cost_approx_usd).toBeCloseTo(0.03 + 0.0054 + 1.2, 10);
  });
});

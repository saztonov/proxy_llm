import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, chatSuccessBody, type MockServer } from './helpers/mock-openrouter.js';

const ALPHA = 'alpha-token-1234567890';
const BETA = 'beta-token-1234567890';
const GAMMA = 'gamma-token-1234567890';

describe('multi-tenant proxy', () => {
  let bundle: AppBundle;
  let upstream: MockServer;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'proxy_llm-mt-'));
    const clientsPath = join(dir, 'clients.json');
    writeFileSync(
      clientsPath,
      JSON.stringify({
        clients: [
          {
            clientId: 'alpha',
            tokens: [ALPHA],
            defaultModel: 'alpha/default',
            allowedModels: ['alpha/chosen'],
            openrouterApiKey: 'sk-alpha',
            maxConcurrency: 1,
            maxPending: 1,
          },
          { clientId: 'beta', tokens: [BETA], defaultModel: 'beta/default', maxConcurrency: 1, maxPending: 8 },
          {
            clientId: 'gamma',
            tokens: [GAMMA],
            defaultModel: 'gamma/default',
            allowedModels: ['*'],
            fallbackModels: ['gamma/fb'],
            maxConcurrency: 1,
            maxPending: 8,
          },
        ],
      }),
      'utf8',
    );

    upstream = await startMockOpenRouter(async (_req, res) => {
      await new Promise((r) => setTimeout(r, 300));
      jsonResponse(res, 200, chatSuccessBody());
    });

    bundle = await buildApp(
      makeTestConfig({
        OPENROUTER_BASE_URL: upstream.baseUrl,
        CLIENTS_CONFIG_PATH: clientsPath,
        QUEUE_CONCURRENCY: 8,
        QUEUE_MAX_PENDING: 50,
        REQUEST_DEADLINE_MS: 8000,
        UPSTREAM_ATTEMPT_TIMEOUT_MS: 6000,
      }),
    );
  });

  afterAll(async () => {
    await bundle.app.close();
    bundle.db.close();
    bundle.stopWatchdog();
    bundle.stopDigest();
    await upstream.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (token: string, payload: unknown, headers: Record<string, string> = {}) =>
    bundle.app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: { authorization: `Bearer ${token}`, ...headers },
      payload,
    });

  it('routes per-tenant model and OpenRouter key to upstream', async () => {
    const before = upstream.requests.length;
    const res = await post(ALPHA, { model: 'alpha/chosen', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.statusCode).toBe(200);
    const sent = upstream.requests[before]!;
    expect(JSON.parse(sent.body).model).toBe('alpha/chosen');
    expect(sent.headers['authorization']).toBe('Bearer sk-alpha');
  });

  it('beta with no model → its default; global OpenRouter key', async () => {
    const before = upstream.requests.length;
    const res = await post(BETA, { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.statusCode).toBe(200);
    const sent = upstream.requests[before]!;
    expect(JSON.parse(sent.body).model).toBe('beta/default');
    expect(sent.headers['authorization']).toBe('Bearer sk-or-test-key');
  });

  it('disallowed model → 400 model_not_allowed, no upstream call', async () => {
    const before = upstream.requests.length;
    const res = await post(ALPHA, { model: 'evil/expensive', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('model_not_allowed');
    expect(upstream.requests.length).toBe(before);
  });

  it('unknown token → 401', async () => {
    const res = await post('nope-nope-nope-000000', { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.statusCode).toBe(401);
  });

  it('wildcard client → any model reaches upstream, without a fallback chain', async () => {
    const before = upstream.requests.length;
    const res = await post(GAMMA, { model: 'any/model', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(upstream.requests[before]!.body);
    expect(body.model).toBe('any/model');
    expect(body.models).toBeUndefined();
  });

  // Заглушка не должна долетать до OpenRouter даже там, где разрешено всё.
  it('wildcard client → sentinel resolves to default + fallback chain', async () => {
    const before = upstream.requests.length;
    const res = await post(GAMMA, { model: 'proxy', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(upstream.requests[before]!.body);
    expect(body.models).toEqual(['gamma/default', 'gamma/fb']);
    expect(body.model).toBeUndefined();
  });

  it('sentinel under an explicit allowlist → 200 with default, not model_not_allowed', async () => {
    const before = upstream.requests.length;
    const res = await post(ALPHA, { model: 'proxy', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(upstream.requests[before]!.body).model).toBe('alpha/default');
  });

  // Обратная совместимость: beta (пустой allowlist) шлёт реальный слаг «по-старому».
  it('empty allowlist still ignores a real slug → client default', async () => {
    const before = upstream.requests.length;
    const res = await post(BETA, { model: 'expensive/model', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(upstream.requests[before]!.body).model).toBe('beta/default');
  });

  it('same idempotency key from two different tenants → two upstream calls (no cross-client merge)', async () => {
    const before = upstream.requests.length;
    const key = 'shared-idem-key-xyz';
    const [a, b] = await Promise.all([
      post(ALPHA, { model: 'alpha/chosen', messages: [{ role: 'user', content: 'x' }] }, { 'x-idempotency-key': key }),
      post(BETA, { messages: [{ role: 'user', content: 'x' }] }, { 'x-idempotency-key': key }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(upstream.requests.length - before).toBe(2);
  });

  it('per-client cap isolates tenants: alpha floods to 503 while beta still passes', async () => {
    const floodAlpha = Array.from({ length: 6 }, (_, i) =>
      post(ALPHA, { model: 'alpha/chosen', messages: [{ role: 'user', content: 'flood' }] }, { 'x-request-id': `a-${i}` }),
    );
    const betaReq = post(BETA, { messages: [{ role: 'user', content: 'ok' }] }, { 'x-request-id': 'b-0' });
    const [alphaResults, betaRes] = await Promise.all([Promise.all(floodAlpha), betaReq]);
    const alphaCodes = alphaResults.map((r) => r.statusCode);
    // alpha capacity = maxConcurrency(1)+maxPending(1)=2 → часть 6 запросов отбивается 503
    expect(alphaCodes.filter((c) => c === 503).length).toBeGreaterThanOrEqual(1);
    const rejected = alphaResults.find((r) => r.statusCode === 503);
    expect(rejected!.headers['retry-after']).toBe('10');
    // beta не задет лимитом alpha
    expect(betaRes.statusCode).toBe(200);
  });
});

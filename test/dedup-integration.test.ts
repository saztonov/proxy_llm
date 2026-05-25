import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, chatSuccessBody, type MockServer } from './helpers/mock-openrouter.js';

describe('idempotency dedup integration', () => {
  let bundle: AppBundle;
  let upstream: MockServer;
  const token = 'dedup-tok-1234567890';

  beforeAll(async () => {
    upstream = await startMockOpenRouter(async (_req, res) => {
      await new Promise((r) => setTimeout(r, 300));
      jsonResponse(res, 200, chatSuccessBody('shared-result'));
    });
    bundle = await buildApp(
      makeTestConfig({
        OPENROUTER_BASE_URL: upstream.baseUrl,
        PROXY_INBOUND_TOKEN: token,
        QUEUE_CONCURRENCY: 2,
      }),
    );
  });

  afterAll(async () => {
    await bundle.app.close();
    bundle.db.close();
    bundle.stopWatchdog();
    bundle.stopDigest();
    await upstream.close();
  });

  it('two parallel requests with same idempotency key → single upstream call', async () => {
    upstream.requests.length = 0;
    const headers = {
      authorization: `Bearer ${token}`,
      'x-idempotency-key': 'job-abc-123',
    };
    const payload = { messages: [{ role: 'user', content: 'doc' }] };

    const [r1, r2] = await Promise.all([
      bundle.app.inject({ method: 'POST', url: '/api/v1/chat/completions', headers, payload }),
      bundle.app.inject({ method: 'POST', url: '/api/v1/chat/completions', headers, payload }),
    ]);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r1.body).toBe(r2.body);
    expect(upstream.requests).toHaveLength(1);
  });

  it('different idempotency keys → different upstream calls', async () => {
    upstream.requests.length = 0;
    const payload = { messages: [{ role: 'user', content: 'doc' }] };
    const [r1, r2] = await Promise.all([
      bundle.app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        headers: { authorization: `Bearer ${token}`, 'x-idempotency-key': 'job-a' },
        payload,
      }),
      bundle.app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        headers: { authorization: `Bearer ${token}`, 'x-idempotency-key': 'job-b' },
        payload,
      }),
    ]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(upstream.requests).toHaveLength(2);
  });
});

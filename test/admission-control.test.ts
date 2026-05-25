import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, chatSuccessBody, type MockServer } from './helpers/mock-openrouter.js';

describe('admission control', () => {
  let bundle: AppBundle;
  let upstream: MockServer;
  const token = 'adm-tok-1234567890';

  beforeAll(async () => {
    upstream = await startMockOpenRouter(async (_req, res) => {
      // Медленный mock — даёт нам время заполнить очередь
      await new Promise((r) => setTimeout(r, 500));
      jsonResponse(res, 200, chatSuccessBody());
    });
    bundle = await buildApp(
      makeTestConfig({
        OPENROUTER_BASE_URL: upstream.baseUrl,
        PROXY_INBOUND_TOKEN: token,
        QUEUE_CONCURRENCY: 1,
        QUEUE_MAX_PENDING: 2,
        REQUEST_DEADLINE_MS: 4000,
        UPSTREAM_ATTEMPT_TIMEOUT_MS: 3000,
        MIN_REMAINING_MS: 200,
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

  it('returns 413 when Content-Length exceeds BODY_LIMIT_BYTES, without reading body', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: {
        authorization: `Bearer ${token}`,
        'content-length': String(50_000_000),
      },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(413);
  });

  it('returns 503 with Retry-After when queue is full', async () => {
    // Послать N запросов параллельно, чтобы очередь заполнилась
    const promises = Array.from({ length: 5 }, (_, i) =>
      bundle.app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        headers: { authorization: `Bearer ${token}`, 'x-request-id': `req-${i}` },
        payload: { messages: [{ role: 'user', content: 'hi' }] },
      }),
    );
    const results = await Promise.all(promises);
    const codes = results.map((r) => r.statusCode);
    // как минимум один отказ 503
    expect(codes).toContain(503);
    const rejected = results.find((r) => r.statusCode === 503);
    expect(rejected!.headers['retry-after']).toBe('10');
  });
});

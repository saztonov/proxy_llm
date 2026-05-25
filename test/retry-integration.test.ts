import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, chatSuccessBody, type MockServer } from './helpers/mock-openrouter.js';

describe('retry policy integration', () => {
  it('retries 429 with Retry-After (seconds) and succeeds', async () => {
    let count = 0;
    const upstream: MockServer = await startMockOpenRouter((_req, res) => {
      count++;
      if (count === 1) {
        jsonResponse(res, 429, { error: { code: 'rate_limit', message: 'slow down' } }, { 'retry-after': '1' });
      } else {
        jsonResponse(res, 200, chatSuccessBody());
      }
    });
    const token = 'r429-tok-1234567890';
    const bundle: AppBundle = await buildApp(
      makeTestConfig({
        OPENROUTER_BASE_URL: upstream.baseUrl,
        PROXY_INBOUND_TOKEN: token,
        UPSTREAM_MAX_ATTEMPTS: 2,
        REQUEST_DEADLINE_MS: 6000,
        UPSTREAM_ATTEMPT_TIMEOUT_MS: 3000,
        MIN_REMAINING_MS: 200,
      }),
    );
    try {
      const res = await bundle.app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        headers: { authorization: `Bearer ${token}` },
        payload: { messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.statusCode).toBe(200);
      expect(count).toBe(2);
    } finally {
      await bundle.app.close();
      bundle.db.close();
      bundle.stopWatchdog();
      bundle.stopDigest();
      await upstream.close();
    }
  });

  it('does not retry 401', async () => {
    let count = 0;
    const upstream: MockServer = await startMockOpenRouter((_req, res) => {
      count++;
      jsonResponse(res, 401, { error: { code: 'unauthorized', message: 'bad key' } });
    });
    const token = 'r401-tok-1234567890';
    const bundle = await buildApp(
      makeTestConfig({
        OPENROUTER_BASE_URL: upstream.baseUrl,
        PROXY_INBOUND_TOKEN: token,
        UPSTREAM_MAX_ATTEMPTS: 3,
      }),
    );
    try {
      const res = await bundle.app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        headers: { authorization: `Bearer ${token}` },
        payload: { messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.statusCode).toBe(401);
      expect(count).toBe(1);
    } finally {
      await bundle.app.close();
      bundle.db.close();
      bundle.stopWatchdog();
      bundle.stopDigest();
      await upstream.close();
    }
  });
});

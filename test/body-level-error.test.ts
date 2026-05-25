import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, type MockServer } from './helpers/mock-openrouter.js';

describe('body-level error (200 + body.error)', () => {
  let bundle: AppBundle;
  let upstream: MockServer;
  const token = 'body-err-tok-12345';

  beforeAll(async () => {
    upstream = await startMockOpenRouter((_req, res) => {
      // HTTP 200, но в теле ошибка от провайдера
      jsonResponse(res, 200, {
        error: { code: 'content_policy', message: 'blocked by moderation' },
      });
    });
    bundle = await buildApp(
      makeTestConfig({
        OPENROUTER_BASE_URL: upstream.baseUrl,
        PROXY_INBOUND_TOKEN: token,
        UPSTREAM_MAX_ATTEMPTS: 1,
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

  it('passes HTTP 200 to client but journals as body_level_error', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: { authorization: `Bearer ${token}` },
      payload: { messages: [{ role: 'user', content: 'forbidden' }] },
    });
    expect(res.statusCode).toBe(200);

    // Verify journal
    const rows = bundle.db.db
      .prepare(`SELECT status, http_status, error_code FROM requests ORDER BY id DESC LIMIT 1`)
      .all() as { status: string; http_status: number; error_code: string }[];
    expect(rows[0]!.http_status).toBe(200);
    expect(rows[0]!.status).toBe('body_level_error');
    expect(rows[0]!.error_code).toBe('content_policy');
  });

  it('does not retry moderation errors (content_policy is terminal)', async () => {
    upstream.requests.length = 0;
    await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: { authorization: `Bearer ${token}` },
      payload: { messages: [{ role: 'user', content: 'blocked' }] },
    });
    expect(upstream.requests).toHaveLength(1);
  });
});

describe('body-level retryable error', () => {
  let bundle: AppBundle;
  let upstream: MockServer;
  const token = 'body-retry-tok-12345';
  let callCount = 0;

  beforeAll(async () => {
    upstream = await startMockOpenRouter((_req, res) => {
      callCount++;
      if (callCount === 1) {
        jsonResponse(res, 200, { error: { code: 'provider_unavailable', message: 'temp' } });
      } else {
        jsonResponse(res, 200, {
          id: 'gen-x',
          model: 'mock/model',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        });
      }
    });
    bundle = await buildApp(
      makeTestConfig({
        OPENROUTER_BASE_URL: upstream.baseUrl,
        PROXY_INBOUND_TOKEN: token,
        UPSTREAM_MAX_ATTEMPTS: 2,
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

  it('retries provider_unavailable and succeeds on second attempt', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: { authorization: `Bearer ${token}` },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(callCount).toBe(2);
  });
});

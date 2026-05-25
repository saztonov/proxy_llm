import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, type MockServer } from './helpers/mock-openrouter.js';

describe('malformed_success', () => {
  let bundle: AppBundle;
  let upstream: MockServer;
  const token = 'malf-tok-1234567890';

  beforeAll(async () => {
    upstream = await startMockOpenRouter((_req, res) => {
      // 200 без choices
      jsonResponse(res, 200, { id: 'gen-x', model: 'mock/model' });
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

  it('journals 200-without-choices as malformed_success', async () => {
    upstream.requests.length = 0;
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: { authorization: `Bearer ${token}` },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    // По решению: malformed_success → НЕ ретраим, отдаём как есть клиенту
    expect(res.statusCode).toBe(200);
    expect(upstream.requests).toHaveLength(1);

    const row = bundle.db.db
      .prepare(`SELECT status, error_code FROM requests ORDER BY id DESC LIMIT 1`)
      .get() as { status: string; error_code: string };
    expect(row.status).toBe('malformed_success');
    expect(row.error_code).toBe('missing_choices');
  });
});

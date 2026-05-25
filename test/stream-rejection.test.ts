import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, chatSuccessBody, type MockServer } from './helpers/mock-openrouter.js';

describe('stream rejection', () => {
  let bundle: AppBundle;
  let upstream: MockServer;
  const token = 'stream-tok-1234567890';

  beforeAll(async () => {
    upstream = await startMockOpenRouter((_req, res) => jsonResponse(res, 200, chatSuccessBody()));
    bundle = await buildApp(makeTestConfig({ OPENROUTER_BASE_URL: upstream.baseUrl, PROXY_INBOUND_TOKEN: token }));
  });

  afterAll(async () => {
    await bundle.app.close();
    bundle.db.close();
    bundle.stopWatchdog();
    bundle.stopDigest();
    await upstream.close();
  });

  it('returns 400 when stream=true', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: { authorization: `Bearer ${token}` },
      payload: { stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res.body) as { error: { code: string } };
    expect(parsed.error.code).toBe('streaming_not_supported');
    // upstream should NOT have been called
    expect(upstream.requests).toHaveLength(0);
  });
});

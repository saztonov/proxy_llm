import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, chatSuccessBody, type MockServer } from './helpers/mock-openrouter.js';

describe('auth', () => {
  let bundle: AppBundle;
  let upstream: MockServer;

  beforeAll(async () => {
    upstream = await startMockOpenRouter((_req, res) => jsonResponse(res, 200, chatSuccessBody()));
    bundle = await buildApp(
      makeTestConfig({
        OPENROUTER_BASE_URL: upstream.baseUrl,
        PROXY_INBOUND_TOKEN: 'super-secret-token-1234',
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

  it('rejects request without Authorization', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects with wrong Bearer token', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: { authorization: 'Bearer wrong' },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts correct Bearer token', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: { authorization: 'Bearer super-secret-token-1234' },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
  });
});

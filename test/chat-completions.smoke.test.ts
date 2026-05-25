import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, chatSuccessBody, type MockServer } from './helpers/mock-openrouter.js';

describe('chat-completions smoke', () => {
  let bundle: AppBundle;
  let upstream: MockServer;
  const token = 'tok-smoke-test-1234';

  beforeAll(async () => {
    upstream = await startMockOpenRouter((_req, res) => jsonResponse(res, 200, chatSuccessBody('Распознано')));
    bundle = await buildApp(
      makeTestConfig({
        OPENROUTER_BASE_URL: upstream.baseUrl,
        PROXY_INBOUND_TOKEN: token,
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

  it('proxies a basic OCR-shaped request and journals it', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: {
        authorization: `Bearer ${token}`,
        'x-request-id': 'req-smoke-1',
      },
      payload: {
        messages: [{ role: 'user', content: 'распознай документ' }],
        temperature: 0,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-proxy-request-id']).toBe('req-smoke-1');
    expect(res.headers['x-openrouter-request-id']).toMatch(/^gen-/);
    const parsed = JSON.parse(res.body) as { choices: { message: { content: string } }[] };
    expect(parsed.choices[0]!.message.content).toBe('Распознано');

    // upstream got model from proxy config, not from client (client didn't send one)
    expect(upstream.requests[0]!.body).toContain('"model":"mock/model"');
    // stream forced to false
    expect(upstream.requests[0]!.body).toContain('"stream":false');
    // X-OpenRouter-Title is set
    expect(upstream.requests[0]!.headers['x-openrouter-title']).toBe('test');
  });

  it('proxy ignores client-supplied model and overwrites it', async () => {
    upstream.requests.length = 0;
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/chat/completions',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        model: 'evil/picked-by-client',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const sentBody = JSON.parse(upstream.requests[0]!.body) as Record<string, unknown>;
    expect(sentBody.model).toBe('mock/model');
    expect(sentBody.model).not.toBe('evil/picked-by-client');
  });

  it('alias /v1/chat/completions also works', async () => {
    const res = await bundle.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${token}` },
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
  });
});

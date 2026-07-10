import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import {
  startMockOpenRouter,
  jsonResponse,
  chatSuccessBody,
  type MockServer,
} from './helpers/mock-openrouter.js';

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
    // UPSTREAM_MAX_ATTEMPTS=1 — второй попытки нет из-за кэпа, отдаём как есть клиенту
    expect(res.statusCode).toBe(200);
    expect(upstream.requests).toHaveLength(1);

    const row = bundle.db.db
      .prepare(`SELECT status, error_code FROM requests ORDER BY id DESC LIMIT 1`)
      .get() as { status: string; error_code: string };
    expect(row.status).toBe('malformed_success');
    expect(row.error_code).toBe('missing_choices');
  });
});

describe('malformed_success retry policy', () => {
  const token = 'malf-retry-tok-1234567890';

  it('retries finish_reason=error and returns success on 2nd attempt', async () => {
    const upstream = await startMockOpenRouter((_req, res) => {
      // 1-я попытка: сорванная генерация (200 + finish_reason=error); 2-я: валидный success
      if (upstream.requests.length === 1) {
        jsonResponse(res, 200, {
          id: 'gen-e',
          model: 'mock/model',
          choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'error' }],
        });
      } else {
        jsonResponse(res, 200, chatSuccessBody('recovered'));
      }
    });
    const bundle = await buildApp(
      makeTestConfig({
        OPENROUTER_BASE_URL: upstream.baseUrl,
        PROXY_INBOUND_TOKEN: token,
        UPSTREAM_MAX_ATTEMPTS: 2,
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
      expect(upstream.requests).toHaveLength(2); // была вторая попытка
      const row = bundle.db.db
        .prepare(`SELECT status, attempt_count FROM requests ORDER BY id DESC LIMIT 1`)
        .get() as { status: string; attempt_count: number };
      expect(row.status).toBe('success');
      expect(row.attempt_count).toBe(2);
    } finally {
      await bundle.app.close();
      bundle.db.close();
      bundle.stopWatchdog();
      bundle.stopDigest();
      await upstream.close();
    }
  }, 10_000); // ретрай ждёт backoff ~2s — поднимаем таймаут теста

  it('does NOT retry empty_content', async () => {
    const upstream = await startMockOpenRouter((_req, res) => {
      // 200 с пустым content — может быть легитимно, ретраить не нужно
      jsonResponse(res, 200, {
        id: 'gen-empty',
        model: 'mock/model',
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      });
    });
    const bundle = await buildApp(
      makeTestConfig({
        OPENROUTER_BASE_URL: upstream.baseUrl,
        PROXY_INBOUND_TOKEN: token,
        UPSTREAM_MAX_ATTEMPTS: 2,
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
      expect(upstream.requests).toHaveLength(1); // повтора не было
      const row = bundle.db.db
        .prepare(`SELECT status, error_code FROM requests ORDER BY id DESC LIMIT 1`)
        .get() as { status: string; error_code: string };
      expect(row.status).toBe('malformed_success');
      expect(row.error_code).toBe('empty_content');
    } finally {
      await bundle.app.close();
      bundle.db.close();
      bundle.stopWatchdog();
      bundle.stopDigest();
      await upstream.close();
    }
  });
});

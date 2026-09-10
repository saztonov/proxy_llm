import { describe, expect, it, afterEach, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request } from 'undici';
import { buildApp, type AppBundle } from '../src/app.js';
import type { Config } from '../src/config.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, type MockServer } from './helpers/mock-openrouter.js';
import { seedAgent } from './helpers/agent-seed.js';
import { chatChunk, sseResponse, type SseHandle } from './helpers/mock-openai.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const streamBody = { stream: true, messages: [{ role: 'user', content: 'hi' }] };

describe('agent contour: streaming failures', () => {
  let up: MockServer;
  let b: AppBundle;
  let handler: Handler;

  const start = async (overrides: Partial<Config> = {}): Promise<string> => {
    up = await startMockOpenRouter((req, res) => handler(req, res));
    b = await buildApp(makeTestConfig({ OPENROUTER_BASE_URL: up.baseUrl, ...overrides }));
    return seedAgent(b, { baseUrl: `${up.baseUrl}/v1` }).token;
  };
  afterEach(async () => {
    await b.app.close();
    b.db.close();
    b.stopTickers();
    await up.close();
  });

  const post = (token: string) =>
    b.app.inject({ method: 'POST', url: '/agent/v1/chat/completions', headers: { authorization: `Bearer ${token}` }, payload: streamBody });
  const lastRequest = () => b.db.db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 1').get();

  it('retryable error as the first event is retried before anything reaches the client', async () => {
    let n = 0;
    handler = (_q, res) => {
      n += 1;
      if (n === 1) sseResponse(res, [{ error: { message: 'down', code: 'provider_unavailable' } }]);
      else sseResponse(res, [chatChunk('ok', { finish_reason: 'stop' })]);
    };
    const token = await start();
    const r = await post(token);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('"ok"');
    expect(r.body).not.toContain('down');
    expect(n).toBe(2);
    const cls = b.db.db.prepare('SELECT classification FROM billing_attempts ORDER BY id').all();
    expect(cls).toEqual([{ classification: 'body_level_error' }, { classification: 'success' }]);
  });

  it('terminal error as the first event becomes a plain JSON error with the provider status', async () => {
    handler = (_q, res) => {
      sseResponse(res, [{ error: { message: 'context too long', code: 400 } }]);
    };
    const r = await post(await start());
    expect(r.statusCode).toBe(400);
    expect(r.headers['content-type']).toContain('application/json');
    expect(r.json().error.message).toBe('context too long');
  });

  it('a provider that goes silent mid-stream gets cut with a synthetic error event', async () => {
    handler = (_q, res) => {
      sseResponse(res, [chatChunk('start')], { hangAfter: true });
    };
    const r = await post(await start({ AGENT_STREAM_IDLE_TIMEOUT_MS: 300 }));
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('stream_idle_timeout');
    expect(r.body.trim().endsWith('data: [DONE]')).toBe(true);
    expect(lastRequest()).toMatchObject({ status: 'timeout', error_code: 'stream_idle_timeout' });
  });

  it('no data event in time: 504 JSON before commit, keep-alive comments do not count', async () => {
    handler = (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': keepalive\n\n');
    };
    const r = await post(await start({ AGENT_STREAM_FIRST_EVENT_TIMEOUT_MS: 300, AGENT_UPSTREAM_MAX_ATTEMPTS: 1 }));
    expect(r.statusCode).toBe(504);
    expect(r.json().error.code).toBe('first_event_timeout');
  });

  it('a provider flooding bytes before the first event is cut at 1 MiB, before anything is sent', async () => {
    handler = (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const line = ': ' + 'x'.repeat(64 * 1024) + '\n\n';
      for (let i = 0; i < 24; i++) res.write(line);
    };
    const r = await post(await start({ AGENT_UPSTREAM_MAX_ATTEMPTS: 1 }));
    expect(r.statusCode).toBe(502);
    expect(r.headers['content-type']).toContain('application/json');
    expect(r.json().error.code).toBe('upstream_response_too_large');
  });

  it('client disconnect mid-stream aborts the provider call and frees the slot', async () => {
    let handle: SseHandle | undefined;
    handler = (_q, res) => {
      handle = sseResponse(res, Array.from({ length: 60 }, (_, i) => chatChunk(`t${i}`)), { delayMs: 50 });
    };
    const token = await start();
    await b.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = b.app.server.address() as AddressInfo;
    const res = await request(`http://127.0.0.1:${port}/agent/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(streamBody),
    });
    expect(res.statusCode).toBe(200);
    const it = res.body[Symbol.asyncIterator]();
    await it.next();
    await it.next();
    res.body.destroy();

    await vi.waitFor(() => expect(handle?.closedByPeer()).toBe(true), { timeout: 4000 });
    await vi.waitFor(() => expect(lastRequest()).toMatchObject({ status: 'client_aborted' }), { timeout: 4000 });
    expect(b.agentFairness.snapshot().globalActive).toBe(0);
    expect(b.agentActiveMetrics.size()).toBe(0);
  });
});

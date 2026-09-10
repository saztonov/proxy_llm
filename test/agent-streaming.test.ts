import { describe, expect, it, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp, type AppBundle } from '../src/app.js';
import type { Config } from '../src/config.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, type MockServer } from './helpers/mock-openrouter.js';
import { seedAgent } from './helpers/agent-seed.js';
import { chatChunk, sseResponse } from './helpers/mock-openai.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const USAGE = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, cost: 0.0042 };
const streamBody = { stream: true, model: 'whatever', messages: [{ role: 'user', content: 'hi' }] };

describe('agent contour: streaming', () => {
  let up: MockServer;
  let b: AppBundle;
  let handler: Handler;

  const start = async (overrides: Partial<Config> = {}): Promise<void> => {
    up = await startMockOpenRouter((req, res) => handler(req, res));
    b = await buildApp(makeTestConfig({ OPENROUTER_BASE_URL: up.baseUrl, ...overrides }));
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
  const attempts = () => b.db.db.prepare('SELECT * FROM billing_attempts ORDER BY id').all();

  it('proxies SSE as is, reads usage from the trailing chunk and bills it', async () => {
    handler = (_q, res) => {
      sseResponse(res, [chatChunk('Hel'), chatChunk('lo', { finish_reason: 'stop' }), chatChunk(null, { usage: USAGE })], { keepalive: true });
    };
    await start();
    const s = seedAgent(b, { baseUrl: `${up.baseUrl}/v1`, usageMode: 'openrouter' });
    const r = await post(s.token);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/event-stream');
    expect(r.headers['x-accel-buffering']).toBe('no');
    expect(r.body).toContain('"Hel"');
    expect(r.body).toContain('"lo"');
    expect(r.body.trim().endsWith('data: [DONE]')).toBe(true);
    expect(JSON.parse(up.requests[0]!.body).usage).toEqual({ include: true });
    expect(lastRequest()).toMatchObject({ status: 'success', contour: 'agent', prompt_tokens: 12 });
    expect(attempts()).toEqual([
      expect.objectContaining({ classification: 'success', cost_usd: 0.0042, usage_source: 'response', prompt_tokens: 12 }),
    ]);
  });

  it('asks generic providers for usage via stream_options; usage without cost stays unknown money', async () => {
    handler = (_q, res) => {
      sseResponse(res, [chatChunk('x', { finish_reason: 'stop' }), chatChunk(null, { usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })]);
    };
    await start();
    const s = seedAgent(b, { baseUrl: `${up.baseUrl}/v1` });
    expect((await post(s.token)).statusCode).toBe(200);
    expect(JSON.parse(up.requests[0]!.body).stream_options).toEqual({ include_usage: true });
    expect(attempts()[0]).toMatchObject({ prompt_tokens: 5, cost_usd: null, usage_source: 'missing', est_quality: 'no_price' });
  });

  it('an error event in the middle of the stream reaches the client and is journaled', async () => {
    handler = (_q, res) => {
      sseResponse(res, [chatChunk('part'), { error: { message: 'boom', code: 'server_error' } }]);
    };
    await start();
    const s = seedAgent(b, { baseUrl: `${up.baseUrl}/v1` });
    const r = await post(s.token);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('boom');
    expect(lastRequest()).toMatchObject({ status: 'stream_upstream_error', error_code: 'server_error' });
  });

  it('EOF without [DONE] is flagged to the client and in the journal', async () => {
    handler = (_q, res) => {
      sseResponse(res, [chatChunk('cut')], { done: false });
    };
    await start();
    const s = seedAgent(b, { baseUrl: `${up.baseUrl}/v1` });
    const r = await post(s.token);
    expect(r.body).toContain('stream_incomplete');
    expect(lastRequest()).toMatchObject({ status: 'stream_incomplete', error_code: 'eof_without_done' });
  });
});

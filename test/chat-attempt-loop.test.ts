import { describe, expect, it } from 'vitest';
import { runChatAttempts, type AttemptLoopOptions } from '../src/upstream/chat-attempt-loop.js';
import { createDeadline } from '../src/upstream/deadline.js';
import type { AttemptClassification } from '../src/upstream/types.js';
import { startMockOpenRouter, jsonResponse, chatSuccessBody } from './helpers/mock-openrouter.js';
import { capturingLogger } from './helpers/silent-logger.js';

const policy = { maxAttempts: 2, attemptTimeoutMs: 2000, minRemainingMs: 100, responseBodyLimitBytes: 1_000_000 };

function opts(endpoint: string, extra: Partial<AttemptLoopOptions> = {}): AttemptLoopOptions {
  return {
    endpoint,
    headers: { 'content-type': 'application/json' },
    bodyJson: '{}',
    requestId: 'r-1',
    deadline: createDeadline(Date.now(), 5000, 100),
    policy,
    fallbackUsed: () => null,
    proxyErrorBody: (code, message) => JSON.stringify({ error: { message, type: 'proxy_error', code } }),
    filterHeaders: (_u, rid) => ({ 'content-type': 'application/json', 'x-proxy-request-id': rid, 'x-custom': '1' }),
    logger: capturingLogger().logger,
    ...extra,
  };
}

describe('runChatAttempts', () => {
  it('uses the caller error format and header filter for proxy-made errors', async () => {
    const r = await runChatAttempts(opts('http://127.0.0.1:9/v1/chat/completions', { policy: { ...policy, maxAttempts: 1 } }));
    expect(r.statusCode).toBe(504);
    expect(JSON.parse(r.bodyText).error).toMatchObject({ type: 'proxy_error', code: 'network_error' });
    expect(r.headers['x-custom']).toBe('1');
  });

  it('does not retry after an external abort (the client is gone, a retry would just cost money)', async () => {
    let calls = 0;
    const up = await startMockOpenRouter(() => {
      calls += 1;
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const t0 = Date.now();
    const r = await runChatAttempts(opts(`${up.baseUrl}/v1/chat/completions`, { signal: ac.signal }));
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(calls).toBe(1);
    expect(r.classification).toBe('network_error');
    expect(r.errorCode).toBe('aborted');
    await up.close();
  });

  it('retries a retryable status and reports every paid attempt', async () => {
    let n = 0;
    const up = await startMockOpenRouter((_req, res) => {
      n += 1;
      if (n === 1) jsonResponse(res, 503, { error: { message: 'busy' } }, { 'retry-after': '0' });
      else jsonResponse(res, 200, chatSuccessBody());
    });
    const seen: AttemptClassification[] = [];
    const r = await runChatAttempts(opts(`${up.baseUrl}/v1/chat/completions`, { onAttempt: (o) => seen.push(o.classification) }));
    expect(r.statusCode).toBe(200);
    expect(r.attemptCount).toBe(2);
    expect(seen).toEqual(['upstream_error', 'success']);
    await up.close();
  });
});

import { describe, expect, it } from 'vitest';
import { classifyHttp, classifyNetwork, computeBackoffMs } from '../src/upstream/retry.js';

describe('retry classification', () => {
  it('classifies 200 with valid choices as success', () => {
    const c = classifyHttp(200, {
      id: 'gen-1',
      model: 'm',
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    });
    expect(c.kind).toBe('success');
  });

  it('classifies 200 with body.error as body_level_error', () => {
    const c = classifyHttp(200, {
      error: { code: 'provider_unavailable', message: 'upstream down' },
    });
    expect(c.kind).toBe('body_level_error');
    if (c.kind === 'body_level_error') {
      expect(c.retryable).toBe(true);
      expect(c.code).toBe('provider_unavailable');
    }
  });

  it('classifies 200 with moderation error as terminal body_level_error', () => {
    const c = classifyHttp(200, {
      error: { code: 'content_policy', message: 'blocked' },
    });
    expect(c.kind).toBe('body_level_error');
    if (c.kind === 'body_level_error') {
      expect(c.retryable).toBe(false);
    }
  });

  it('classifies 200 without choices as malformed_success', () => {
    const c = classifyHttp(200, { id: 'gen-1', model: 'm' });
    expect(c.kind).toBe('malformed_success');
  });

  it('classifies 200 with empty content as malformed_success', () => {
    const c = classifyHttp(200, {
      id: 'gen-1',
      choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
    });
    expect(c.kind).toBe('malformed_success');
  });

  it('classifies 200 with finish_reason=error as malformed_success', () => {
    const c = classifyHttp(200, {
      id: 'gen-1',
      choices: [{ message: { content: 'partial' }, finish_reason: 'error' }],
    });
    expect(c.kind).toBe('malformed_success');
  });

  it('classifies 429 as retryable upstream_error', () => {
    const c = classifyHttp(429, { error: { code: 'rate_limit', message: 'slow down' } });
    expect(c.kind).toBe('upstream_error');
    if (c.kind === 'upstream_error') {
      expect(c.retryable).toBe(true);
      expect(c.httpStatus).toBe(429);
    }
  });

  it('classifies 401 as terminal', () => {
    const c = classifyHttp(401, { error: { code: 'unauthorized', message: 'bad key' } });
    expect(c.kind).toBe('upstream_error');
    if (c.kind === 'upstream_error') {
      expect(c.retryable).toBe(false);
    }
  });

  it('classifies 503 as retryable', () => {
    const c = classifyHttp(503, {});
    expect(c.kind).toBe('upstream_error');
    if (c.kind === 'upstream_error') expect(c.retryable).toBe(true);
  });

  it('classifies network errors as retryable', () => {
    const c = classifyNetwork(new Error('ECONNRESET'));
    expect(c.kind).toBe('network_error');
    expect(c.retryable).toBe(true);
  });

  it('backoff grows exponentially and caps at 10s', () => {
    expect(computeBackoffMs(1)).toBe(2000);
    expect(computeBackoffMs(2)).toBe(4000);
    expect(computeBackoffMs(3)).toBe(8000);
    expect(computeBackoffMs(4)).toBe(10_000);
    expect(computeBackoffMs(10)).toBe(10_000);
  });
});

import { describe, expect, it } from 'vitest';
import { filterResponseHeaders } from '../src/upstream/filter-response-headers.js';

describe('filterResponseHeaders', () => {
  it('preserves content-type and adds X-Proxy-Request-Id', () => {
    const out = filterResponseHeaders(
      { 'content-type': 'application/json; charset=utf-8' },
      'req-1',
      null,
    );
    expect(out['content-type']).toBe('application/json; charset=utf-8');
    expect(out['x-proxy-request-id']).toBe('req-1');
    expect(out['x-openrouter-request-id']).toBeUndefined();
  });

  it('does not copy hop-by-hop or length headers', () => {
    const out = filterResponseHeaders(
      {
        'content-type': 'application/json',
        'content-length': '12345',
        'transfer-encoding': 'chunked',
        'content-encoding': 'gzip',
        'connection': 'keep-alive',
        'set-cookie': 'session=abc',
        'authorization': 'Bearer secret',
      },
      'req-1',
      'gen-99',
    );
    expect(out['content-type']).toBe('application/json');
    expect(out['x-openrouter-request-id']).toBe('gen-99');
    expect(Object.keys(out)).toEqual(
      expect.arrayContaining(['content-type', 'x-proxy-request-id', 'x-openrouter-request-id']),
    );
    // Verify excluded headers are NOT present
    expect((out as Record<string, unknown>)['content-length']).toBeUndefined();
    expect((out as Record<string, unknown>)['transfer-encoding']).toBeUndefined();
    expect((out as Record<string, unknown>)['set-cookie']).toBeUndefined();
    expect((out as Record<string, unknown>)['authorization']).toBeUndefined();
  });

  it('defaults to application/json when content-type missing', () => {
    const out = filterResponseHeaders({}, 'req-1', null);
    expect(out['content-type']).toBe('application/json');
  });
});

import { describe, expect, it } from 'vitest';
import { ActiveRequests, ActiveDedupFullError } from '../src/dedup/active-requests.js';
import type { ProxyResult } from '../src/upstream/openrouter-client.js';

const mockResult = (): ProxyResult => ({
  statusCode: 200,
  headers: {},
  bodyText: '{"ok":true}',
  classification: 'success',
  fallbackUsed: 0,
  attemptCount: 1,
});

describe('ActiveRequests', () => {
  it('joins existing promise for same key', async () => {
    const ar = new ActiveRequests(10);
    let callCount = 0;
    const factory = (): Promise<ProxyResult> => {
      callCount++;
      return new Promise((resolve) => setTimeout(() => resolve(mockResult()), 50));
    };

    const p1 = ar.registerOrJoin('key-1', factory);
    const p2 = ar.registerOrJoin('key-1', factory);
    expect(p1).toBe(p2);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(callCount).toBe(1);
    expect(r1).toBe(r2);
  });

  it('removes entry in finally after completion', async () => {
    const ar = new ActiveRequests(10);
    await ar.registerOrJoin('key-1', async () => mockResult());
    expect(ar.has('key-1')).toBe(false);
    expect(ar.size()).toBe(0);
  });

  it('removes entry on rejection', async () => {
    const ar = new ActiveRequests(10);
    await expect(
      ar.registerOrJoin('key-1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(ar.has('key-1')).toBe(false);
  });

  it('throws ActiveDedupFullError at hard cap, no LRU eviction', () => {
    const ar = new ActiveRequests(2);
    ar.registerOrJoin('a', () => new Promise(() => {}));
    ar.registerOrJoin('b', () => new Promise(() => {}));
    expect(() => ar.registerOrJoin('c', () => new Promise(() => {}))).toThrow(ActiveDedupFullError);
    // existing keys still work — no eviction
    expect(ar.has('a')).toBe(true);
    expect(ar.has('b')).toBe(true);
  });

  it('does not throw when joining existing key at cap', () => {
    const ar = new ActiveRequests(2);
    ar.registerOrJoin('a', () => new Promise(() => {}));
    ar.registerOrJoin('b', () => new Promise(() => {}));
    // join existing should NOT throw even at cap
    const p = ar.registerOrJoin('a', () => new Promise(() => {}));
    expect(p).toBeDefined();
  });
});

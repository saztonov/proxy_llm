import { describe, it, expect } from 'vitest';
import { LoginThrottle } from '../src/admin/auth/login-throttle.js';

const WINDOW_MS = 60_000;
const MAX = 5;

function makeThrottle(startMs = 1_000_000) {
  let now = startMs;
  const throttle = new LoginThrottle({ maxAttempts: MAX, windowMs: WINDOW_MS, now: () => now });
  return {
    throttle,
    advance(ms: number) {
      now += ms;
    },
    set(ms: number) {
      now = ms;
    },
  };
}

describe('LoginThrottle', () => {
  it('allows until maxAttempts failures, then blocks with retryAfterSec > 0', () => {
    const { throttle } = makeThrottle();
    for (let i = 1; i < MAX; i++) {
      expect(throttle.fail('admin')).toBe(i);
      expect(throttle.check('admin')).toEqual({ allowed: true, retryAfterSec: 0 });
    }
    expect(throttle.fail('admin')).toBe(MAX);
    const blocked = throttle.check('admin');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBe(WINDOW_MS / 1000);
  });

  it('counts down retryAfterSec and unblocks once the oldest failure leaves the window', () => {
    const { throttle, advance } = makeThrottle();
    for (let i = 0; i < MAX; i++) throttle.fail('admin');

    advance(30_000);
    expect(throttle.check('admin')).toEqual({ allowed: false, retryAfterSec: 30 });

    advance(29_999);
    expect(throttle.check('admin')).toEqual({ allowed: false, retryAfterSec: 1 });

    advance(1);
    expect(throttle.check('admin')).toEqual({ allowed: true, retryAfterSec: 0 });
    // после выхода из окна все пять неудач устарели одновременно
    expect(throttle.fail('admin')).toBe(1);
  });

  it('uses a sliding window: failures spread over time expire one by one', () => {
    const { throttle, advance } = makeThrottle();
    throttle.fail('admin'); // t=0
    advance(10_000);
    for (let i = 0; i < MAX - 1; i++) throttle.fail('admin'); // t=10s
    expect(throttle.check('admin').allowed).toBe(false);

    advance(50_000); // t=60s: первая неудача (t=0) вышла из окна
    expect(throttle.check('admin')).toEqual({ allowed: true, retryAfterSec: 0 });
    expect(throttle.fail('admin')).toBe(MAX); // снова ровно MAX
    expect(throttle.check('admin').allowed).toBe(false);
  });

  it('extends the block when failures keep coming during it', () => {
    const { throttle, advance } = makeThrottle();
    for (let i = 0; i < MAX; i++) throttle.fail('admin'); // t=0
    advance(10_000);
    expect(throttle.fail('admin')).toBe(MAX + 1); // t=10s
    // блок держится, пока в окне >= MAX неудач: их станет 4 (< MAX), когда
    // вторая по старшинству (t=0) выйдет из окна — в t=60s
    expect(throttle.check('admin')).toEqual({ allowed: false, retryAfterSec: 50 });
    advance(50_000); // t=60s: все пять неудач из t=0 вышли, осталась одна (t=10s)
    expect(throttle.check('admin')).toEqual({ allowed: true, retryAfterSec: 0 });
    expect(throttle.fail('admin')).toBe(2);
  });

  it('normalizes login with trim + lowercase', () => {
    const { throttle } = makeThrottle();
    throttle.fail('Admin');
    throttle.fail('  ADMIN ');
    throttle.fail('admin');
    expect(throttle.fail('aDmIn')).toBe(4);
    expect(throttle.size()).toBe(1);
    throttle.fail('admin');
    expect(throttle.check('  Admin')).toMatchObject({ allowed: false });
  });

  it('keeps logins independent', () => {
    const { throttle } = makeThrottle();
    for (let i = 0; i < MAX; i++) throttle.fail('alice');
    expect(throttle.check('alice').allowed).toBe(false);
    expect(throttle.check('bob').allowed).toBe(true);
    expect(throttle.fail('bob')).toBe(1);
    expect(throttle.size()).toBe(2);
  });

  it('reset clears the counter', () => {
    const { throttle } = makeThrottle();
    for (let i = 0; i < MAX; i++) throttle.fail('admin');
    expect(throttle.check('admin').allowed).toBe(false);
    throttle.reset('  ADMIN ');
    expect(throttle.check('admin')).toEqual({ allowed: true, retryAfterSec: 0 });
    expect(throttle.size()).toBe(0);
    expect(throttle.fail('admin')).toBe(1);
  });

  it('prunes expired logins so the map does not grow', () => {
    const { throttle, advance } = makeThrottle();
    throttle.fail('a'); // t=0
    advance(50_000);
    throttle.fail('b'); // t=50s
    expect(throttle.size()).toBe(2);

    advance(10_000); // t=60s: 'a' вышла из окна
    expect(throttle.size()).toBe(1);
    expect(throttle.check('a')).toEqual({ allowed: true, retryAfterSec: 0 });

    advance(50_000); // t=110s: 'b' вышла
    expect(throttle.size()).toBe(0);
  });

  it('prunes on every call, not only on size()', () => {
    const { throttle, advance } = makeThrottle();
    throttle.fail('a');
    advance(WINDOW_MS);
    // check по другому логину тоже вычищает устаревшие записи
    throttle.check('zzz');
    expect(throttle.size()).toBe(0);
  });

  it('validates constructor options', () => {
    expect(() => new LoginThrottle({ maxAttempts: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => new LoginThrottle({ maxAttempts: 1.5, windowMs: 1000 })).toThrow(RangeError);
    expect(() => new LoginThrottle({ maxAttempts: 5, windowMs: 0 })).toThrow(RangeError);
    expect(() => new LoginThrottle({ maxAttempts: 5, windowMs: -1 })).toThrow(RangeError);
    expect(() => new LoginThrottle({ maxAttempts: 5, windowMs: 1000 })).not.toThrow();
  });

  it('works with the real clock by default', () => {
    const throttle = new LoginThrottle({ maxAttempts: 2, windowMs: 60_000 });
    expect(throttle.fail('x')).toBe(1);
    expect(throttle.fail('x')).toBe(2);
    const res = throttle.check('x');
    expect(res.allowed).toBe(false);
    expect(res.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(res.retryAfterSec).toBeLessThanOrEqual(60);
  });
});

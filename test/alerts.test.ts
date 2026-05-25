import { describe, expect, it } from 'vitest';
import { AlertCooldown } from '../src/alerts/dedup.js';

describe('AlertCooldown', () => {
  it('returns true on first call', () => {
    const c = new AlertCooldown(new Map([['k', 1000]]));
    expect(c.shouldSend('k', 1000)).toBe(true);
  });

  it('blocks when within cooldown window', () => {
    const c = new AlertCooldown(new Map([['k', 1000]]));
    c.markSent('k', 1000);
    expect(c.shouldSend('k', 1500)).toBe(false);
    expect(c.shouldSend('k', 1999)).toBe(false);
  });

  it('allows after cooldown expires', () => {
    const c = new AlertCooldown(new Map([['k', 1000]]));
    c.markSent('k', 1000);
    expect(c.shouldSend('k', 2001)).toBe(true);
  });

  it('cooldown 0 = no cooldown', () => {
    const c = new AlertCooldown(new Map([['k', 0]]));
    c.markSent('k', 1000);
    expect(c.shouldSend('k', 1000)).toBe(true);
    expect(c.shouldSend('k', 1001)).toBe(true);
  });

  it('different keys are independent', () => {
    const c = new AlertCooldown(new Map([['a', 1000], ['b', 1000]]));
    c.markSent('a', 1000);
    expect(c.shouldSend('a', 1500)).toBe(false);
    expect(c.shouldSend('b', 1500)).toBe(true);
  });
});

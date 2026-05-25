import { describe, expect, it } from 'vitest';
import { createDeadline } from '../src/upstream/deadline.js';

describe('deadline', () => {
  it('attemptTimeout never exceeds remaining', async () => {
    const d = createDeadline(Date.now(), 200, 50);
    await new Promise((r) => setTimeout(r, 80));
    const t = d.attemptTimeout(1000);
    expect(t).toBeLessThanOrEqual(200 - 80 + 10);
  });

  it('hasTimeFor respects MIN_REMAINING_MS', () => {
    const d = createDeadline(Date.now(), 1000, 100);
    expect(d.hasTimeFor(500)).toBe(true);
    expect(d.hasTimeFor(950)).toBe(false);
  });

  it('attemptTimeout is at least 1ms', async () => {
    const d = createDeadline(Date.now(), 50, 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(d.attemptTimeout(1000)).toBeGreaterThanOrEqual(1);
  });
});

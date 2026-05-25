import { describe, expect, it } from 'vitest';
import { parseRetryAfterMs } from '../src/upstream/parse-retry-after.js';

describe('parseRetryAfterMs', () => {
  it('parses integer seconds', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs('  120  ')).toBe(120_000);
  });

  it('parses HTTP-date format', () => {
    const future = new Date(Date.now() + 30_000).toUTCString();
    const result = parseRetryAfterMs(future);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(25_000);
    expect(result!).toBeLessThan(35_000);
  });

  it('handles past dates as 0', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterMs(past)).toBe(0);
  });

  it('returns null for invalid input', () => {
    expect(parseRetryAfterMs('not-a-time')).toBeNull();
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
  });

  it('handles array form', () => {
    expect(parseRetryAfterMs(['10'])).toBe(10_000);
  });

  it('does not interpret negative numbers', () => {
    expect(parseRetryAfterMs('-5')).toBeNull();
  });
});

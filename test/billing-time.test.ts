import { describe, expect, it } from 'vitest';
import {
  billingDay,
  billingHour,
  addDays,
  daysBetween,
  isValidDay,
} from '../src/billing/billing-time.js';

const MSK = 'Europe/Moscow';

describe('billingDay', () => {
  // Граница суток — самое вероятное место «потерянных» суток в отчёте.
  it('places the midnight boundary at 21:00 UTC for Europe/Moscow', () => {
    expect(billingDay(Date.parse('2026-03-15T20:59:59.999Z'), MSK)).toBe('2026-03-15');
    expect(billingDay(Date.parse('2026-03-15T21:00:00.000Z'), MSK)).toBe('2026-03-16');
  });

  it('formats as YYYY-MM-DD with zero padding', () => {
    expect(billingDay(Date.parse('2026-01-05T10:00:00.000Z'), MSK)).toBe('2026-01-05');
  });

  it('honours a different timezone', () => {
    const ts = Date.parse('2026-03-15T23:30:00.000Z');
    expect(billingDay(ts, 'UTC')).toBe('2026-03-15');
    expect(billingDay(ts, MSK)).toBe('2026-03-16');
  });

  it('handles year rollover', () => {
    expect(billingDay(Date.parse('2026-12-31T21:00:00.000Z'), MSK)).toBe('2027-01-01');
  });
});

describe('billingHour', () => {
  it('returns the local hour in the billing timezone', () => {
    expect(billingHour(Date.parse('2026-07-20T03:10:00.000Z'), MSK)).toBe(6);
    expect(billingHour(Date.parse('2026-07-20T21:30:00.000Z'), MSK)).toBe(0);
  });
});

describe('addDays / daysBetween', () => {
  it('shifts days across month and year boundaries', () => {
    expect(addDays('2026-07-20', -1)).toBe('2026-07-19');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-07-20', -30)).toBe('2026-06-20');
  });

  it('counts inclusive day distance', () => {
    expect(daysBetween('2026-07-01', '2026-07-31')).toBe(30);
    expect(daysBetween('2026-07-20', '2026-07-20')).toBe(0);
  });
});

describe('isValidDay', () => {
  it('accepts real dates and rejects impossible ones', () => {
    expect(isValidDay('2026-07-20')).toBe(true);
    expect(isValidDay('2026-02-29')).toBe(false); // 2026 не високосный
    expect(isValidDay('2026-13-01')).toBe(false);
    expect(isValidDay('2026-7-1')).toBe(false);
    expect(isValidDay('')).toBe(false);
    expect(isValidDay(20260720)).toBe(false);
  });
});

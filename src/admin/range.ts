import { todayIn, addDays, daysBetween, isValidDay } from '../billing/billing-time.js';

export const MAX_RANGE_DAYS = 366;

export type RangeResult = { ok: true; from: string; to: string } | { ok: false; message: string };

/** from/to (YYYY-MM-DD) в биллинговой зоне; по умолчанию — последние 30 суток включительно. */
export function resolveRange(q: { from?: unknown; to?: unknown }, timezone: string): RangeResult {
  const to = q.to === undefined || q.to === '' ? todayIn(timezone) : q.to;
  const from = q.from === undefined || q.from === '' ? addDays(String(to), -29) : q.from;
  if (!isValidDay(from) || !isValidDay(to)) return { ok: false, message: 'from/to must be YYYY-MM-DD dates' };
  const span = daysBetween(from, to);
  if (span < 0) return { ok: false, message: 'from must not be after to' };
  if (span + 1 > MAX_RANGE_DAYS) return { ok: false, message: `range must not exceed ${MAX_RANGE_DAYS} days` };
  return { ok: true, from, to };
}

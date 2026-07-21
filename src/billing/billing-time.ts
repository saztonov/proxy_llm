/**
 * Биллинговые сутки.
 *
 * Сутки считаются в IANA-таймзоне (BILLING_TIMEZONE, по умолчанию Europe/Moscow), а не
 * сдвигом на константу: Node 22 идёт с полным ICU, поэтому Intl отрабатывает переходы и
 * исторические смещения сам. Ключевое следствие — `billing_day` вычисляется ЗДЕСЬ и
 * пишется в колонку, а SQL группирует по готовой строке. Так исключён целый класс багов
 * «граница суток в TS не совпала с границей в SQL».
 *
 * Все timestamps в БД остаются UTC-миллисекундами; таймзона влияет только на билет `billing_day`.
 */

/** 'en-CA' даёт ISO-подобный формат YYYY-MM-DD — единственная локаль, где это гарантировано. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Биллинговые сутки для момента времени: 'YYYY-MM-DD'. */
export function billingDay(tsMs: number, timeZone: string): string {
  return formatterFor(timeZone).format(new Date(tsMs));
}

/** Сегодняшние биллинговые сутки. */
export function todayIn(timeZone: string, now: number = Date.now()): string {
  return billingDay(now, timeZone);
}

/** Час суток (0..23) в биллинговой таймзоне — для планировщика синхронизации цен. */
export function billingHour(tsMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date(tsMs));
  const hour = parts.find((p) => p.type === 'hour')?.value;
  return hour !== undefined ? Number(hour) : new Date(tsMs).getUTCHours();
}

/** Сдвиг дня на N суток: addDays('2026-07-20', -1) === '2026-07-19'. */
export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const base = Date.UTC(y, m - 1, d) + delta * 86_400_000;
  const shifted = new Date(base);
  const yy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Разница в сутках между двумя днями (to - from). */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

/** Валидация 'YYYY-MM-DD' с проверкой на существование даты (не 2026-02-31). */
export function isValidDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * RFC 9110: Retry-After может быть либо неотрицательным числом секунд,
 * либо HTTP-date (IMF-fixdate). Возвращает миллисекунды или null если не парсится.
 */
export function parseRetryAfterMs(value: string | string[] | undefined): number | null {
  if (value === undefined) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === '') return null;

  const trimmed = raw.trim();
  if (/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  // Не пытаемся парсить как Date значения, которые могут быть числовыми — это однозначно секунды.
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(trimmed)) return null;

  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

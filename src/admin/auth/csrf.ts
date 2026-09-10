import { createHmac, timingSafeEqual } from 'node:crypto';

/** HMAC-SHA256(csrfKey, 'csrf:' + sid) в base64url — токен привязан к сессии, хранить его не нужно. */
export function csrfTokenFor(csrfKey: Buffer, sid: string): string {
  return createHmac('sha256', csrfKey).update(`csrf:${sid}`, 'utf8').digest('base64url');
}

/** Timing-safe сравнение с ожидаемым токеном; всё, что не string, → false. */
export function csrfValid(csrfKey: Buffer, sid: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || typeof sid !== 'string') return false;
  const expected = Buffer.from(csrfTokenFor(csrfKey, sid), 'utf8');
  const given = Buffer.from(presented, 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface OriginCheckRequest {
  method: string;
  /** Заголовки в нижнем регистре, как отдаёт Node/Fastify. */
  headers: Record<string, string | string[] | undefined>;
  /** Ожидаемый host (с портом, если он нестандартный) — сверяется с host из Origin. */
  host: string;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' ? v.trim() : undefined;
}

/**
 * Защита в глубину от CSRF независимо от SameSite. Для SAFE_METHODS → true.
 * Иначе:
 *  - sec-fetch-site задан и не 'same-origin' → false;
 *  - origin задан → host из new URL(origin) сравнивается с req.host без учёта
 *    регистра (невалидный URL, пустой host или 'null' → false);
 *  - origin не задан → true только при sec-fetch-site === 'same-origin';
 *  - нет ни того, ни другого → false.
 * Массивы заголовков → берётся первый элемент.
 */
export function isSameOrigin(req: OriginCheckRequest): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;

  const fetchSite = firstHeader(req.headers['sec-fetch-site']);
  if (fetchSite !== undefined && fetchSite !== 'same-origin') return false;

  const origin = firstHeader(req.headers['origin']);
  if (origin !== undefined) {
    if (origin === 'null') return false;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    if (originHost === '') return false;
    return originHost.toLowerCase() === req.host.trim().toLowerCase();
  }

  return fetchSite === 'same-origin';
}

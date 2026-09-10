/**
 * Дополнительные заголовки провайдера задаёт админ (например, OpenAI-Organization или
 * заголовки корпоративного шлюза). Служебные заголовки переопределять нельзя: Authorization
 * собирается из ключа провайдера, остальные ломали бы HTTP или трассировку.
 */
export const FORBIDDEN_PROVIDER_HEADERS: ReadonlySet<string> = new Set([
  'authorization', 'host', 'content-length', 'content-type', 'accept', 'accept-encoding',
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'proxy-authorization', 'x-request-id', 'cookie',
]);

const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** Ошибка валидации или null. Значение — без переводов строк (защита от header injection). */
export function validateExtraHeader(name: string, value: string): string | null {
  if (!HEADER_NAME.test(name)) return `invalid header name: ${name}`;
  if (FORBIDDEN_PROVIDER_HEADERS.has(name.toLowerCase())) return `header is managed by the proxy: ${name}`;
  if (/[\r\n\0]/.test(value) || value.length > 2048) return `invalid header value for ${name}`;
  return null;
}

/** Для рантайма: молча отбрасывает недопустимое (данные в БД могли появиться в обход API). */
export function sanitizeExtraHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && validateExtraHeader(k, v) === null) out[k] = v;
  }
  return out;
}

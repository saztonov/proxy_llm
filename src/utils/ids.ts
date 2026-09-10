import { randomUUID } from 'node:crypto';

export function newRequestId(): string {
  return randomUUID();
}

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

/**
 * Строже, чем isValidRequestId: для публичного агентского API, где заголовок присылает кто
 * угодно. Id попадает в журнал, алерты и заголовок ответа — только безопасные символы.
 */
export function isSafeRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

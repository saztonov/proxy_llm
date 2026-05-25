import { randomUUID } from 'node:crypto';

export function newRequestId(): string {
  return randomUUID();
}

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

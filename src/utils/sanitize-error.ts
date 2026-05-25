import { removeSecrets, truncate } from './sanitize.js';

export interface SanitizedError {
  name: string;
  code?: string;
  message: string;
  stack?: string;
}

export function sanitizeErrorForLog(err: unknown): SanitizedError {
  const e = err as { name?: string; code?: string; message?: string; stack?: string };
  const out: SanitizedError = {
    name: e?.name ?? 'Error',
    message: truncate(removeSecrets(e?.message ?? String(err ?? '')), 500),
  };
  if (e?.code) out.code = e.code;
  if (process.env.NODE_ENV === 'development' && e?.stack) out.stack = e.stack;
  return out;
}

/** Нарушение уникальности (дубликат логина, clientId, имени провайдера...). Админ-API → 409. */
export class ConflictError extends Error {
  override readonly name = 'ConflictError';
  constructor(message: string) {
    super(message);
  }
}

export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

export function isConstraintViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT');
}

/** Выполняет запись, переводя нарушение уникальности в ConflictError с понятным текстом. */
export function withConflict<T>(message: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError(message);
    throw err;
  }
}

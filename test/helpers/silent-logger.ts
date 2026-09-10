import type { Logger } from '../../src/utils/logger.js';

export interface CapturingLogger {
  logger: Logger;
  warnings: string[];
}

/** Логгер-заглушка: ничего не пишет, но запоминает тексты warn/error для ассертов. */
export function capturingLogger(): CapturingLogger {
  const warnings: string[] = [];
  const pick = (a: unknown, b: unknown): string => (typeof a === 'string' ? a : typeof b === 'string' ? b : '');
  const noop = (): void => {};
  const logger = {
    info: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    warn: (a: unknown, b?: unknown) => warnings.push(pick(a, b)),
    error: (a: unknown, b?: unknown) => warnings.push(pick(a, b)),
    child: () => logger,
  } as unknown as Logger;
  return { logger, warnings };
}

import type { AlertEngine } from './rules.js';
import type { Logger } from '../utils/logger.js';

/**
 * Простой scheduler: каждый день в 09:00 по Москве (UTC+3) шлёт дневную сводку.
 * setInterval каждую минуту, проверяет local-hour/minute.
 */
export function startDailyDigest(engine: AlertEngine, logger: Logger): () => void {
  let lastSentDay = -1;

  const interval = setInterval(() => {
    const now = new Date();
    const moscow = new Date(now.getTime() + 3 * 60 * 60_000);
    const hour = moscow.getUTCHours();
    const minute = moscow.getUTCMinutes();
    const day = moscow.getUTCDate();

    if (hour === 9 && minute === 0 && day !== lastSentDay) {
      lastSentDay = day;
      engine.sendDailyDigest().catch((err: unknown) => {
        logger.warn({ err: String(err) }, 'daily digest failed');
      });
    }
  }, 60_000);
  interval.unref?.();

  return () => clearInterval(interval);
}

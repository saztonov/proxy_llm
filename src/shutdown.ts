import type { AppBundle } from './app.js';
import type { Logger } from './utils/logger.js';
import { sanitizeErrorForLog } from './utils/sanitize-error.js';

export interface ShutdownOptions {
  /** Сколько ждать завершения живых запросов, прежде чем оборвать их. */
  drainMs: number;
  /** Сверх drainMs: сколько ещё ждать app.close() после обрыва. */
  closeGraceMs?: number;
  /** Сколько дать прерванным обработчикам дописать журнал до закрытия БД. */
  settleMs?: number;
  logger: Logger;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

/**
 * Остановка без потери журнала.
 *
 * Порядок важен: app.close() ждёт живые соединения, а стрим агента может длиться минутами —
 * дольше TimeoutStopSec юнита. Поэтому таймер drain взводится ДО ожидания close(): по нему все
 * живые запросы обоих контуров получают abort, стримы — синтетическое error-событие, и каждый
 * обработчик сам пишет свою строку журнала. Только после этого закрывается БД.
 * Новые запросы во время close() Fastify отбивает 503 (return503OnClosing).
 */
export async function gracefulShutdown(bundle: AppBundle, opts: ShutdownOptions): Promise<void> {
  const { logger, drainMs } = opts;
  const sources = bundle.activeSources;
  const activeCount = (): number => sources.reduce((n, s) => n + s.size(), 0);

  bundle.stopTickers();

  const drainTimer = setTimeout(() => {
    const aborted = sources.reduce((n, s) => n + s.abortAll(), 0);
    if (aborted > 0) logger.warn({ aborted }, 'drain timeout: aborting active requests');
  }, drainMs);
  drainTimer.unref?.();

  // close() ждёт и keep-alive соединения, ставшие простаивающими уже после его вызова (клиент
  // получил ответ и держит сокет). Пока живых запросов нет — закрываем такие соединения сами.
  const idleSweeper = setInterval(() => {
    if (activeCount() === 0) bundle.app.server.closeIdleConnections();
  }, 50);
  idleSweeper.unref?.();
  try {
    await Promise.race([bundle.app.close(), sleep(drainMs + (opts.closeGraceMs ?? 15_000))]);
  } catch (err) {
    logger.warn({ err: sanitizeErrorForLog(err) }, 'app.close threw');
  } finally {
    clearInterval(idleSweeper);
  }
  clearTimeout(drainTimer);

  const settleUntil = Date.now() + (opts.settleMs ?? 2_000);
  while (activeCount() > 0 && Date.now() < settleUntil) await sleep(25);
  if (activeCount() > 0) {
    logger.warn({ stillActive: activeCount() }, 'shutdown: requests still active, exiting anyway');
  }

  bundle.startupAlert.recordShutdown();
  try {
    bundle.db.close();
  } catch (err) {
    logger.warn({ err: sanitizeErrorForLog(err) }, 'db.close threw');
  }
}

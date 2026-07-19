import type { FairnessManager } from './fairness.js';
import type { ActiveMetrics } from '../routes/chat-completions.js';
import type { Logger } from '../utils/logger.js';

/**
 * Периодически сверяет admission-счётчики FairnessManager с фактическим числом
 * admitted-запросов из ActiveMetrics и самовосстанавливает расхождение.
 *
 * Подробности — см. комментарий у FairnessManager.reconcile(). Интервал по умолчанию
 * совпадает с watchdog-тикером (30s): расхождение живёт максимум один тик, а не до
 * следующего ручного restart.
 */
export function startFairnessReconciler(
  fairness: FairnessManager,
  activeMetrics: ActiveMetrics,
  logger: Logger,
  intervalMs = 30_000,
): () => void {
  const tick = (): void => {
    const corrections = fairness.reconcile(
      activeMetrics.countAdmittedByClient(),
      activeMetrics.countAdmittedTotal(),
    );
    for (const c of corrections) {
      logger.warn(
        { scope: c.scope, trackedActive: c.trackedActive, actualActive: c.actualActive },
        'fairness admission drift corrected',
      );
    }
  };
  const interval = setInterval(tick, intervalMs);
  interval.unref?.();
  return () => clearInterval(interval);
}

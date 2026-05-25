import type { AlertEngine } from '../alerts/rules.js';
import type { Logger } from '../utils/logger.js';
import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface TickerConfig {
  intervalMs: number;
  alertLongRequestMs: number;
  alertDiskFreeMinBytes: number;
  dbPath: string;
}

export interface ActiveRequestSnapshot {
  requestId: string;
  startedAt: number;
  deadlineAt: number;
}

/** Источник данных о текущих активных запросах. */
export interface ActiveSource {
  snapshot(): ActiveRequestSnapshot[];
  abort(requestId: string): void;
}

export function startWatchdogTicker(
  cfg: TickerConfig,
  source: ActiveSource,
  alerts: AlertEngine,
  logger: Logger,
): () => void {
  const stuckAlerted = new Set<string>();

  const tick = async (): Promise<void> => {
    const now = Date.now();
    for (const req of source.snapshot()) {
      const elapsed = now - req.startedAt;
      if (now > req.deadlineAt + 30_000 && !stuckAlerted.has(req.requestId)) {
        stuckAlerted.add(req.requestId);
        logger.warn({ requestId: req.requestId, elapsed }, 'stuck request, forcing abort');
        source.abort(req.requestId);
        await alerts.onStuckRequest(req.requestId, elapsed);
      }
    }

    // Disk space check
    try {
      const stats = await statfs(dirname(cfg.dbPath));
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      if (freeBytes < cfg.alertDiskFreeMinBytes) {
        await alerts.onDiskLow(freeBytes);
      }
    } catch (err) {
      logger.debug({ err: String(err) }, 'statfs failed');
    }
  };

  const interval = setInterval(() => {
    tick().catch((err: unknown) => logger.warn({ err: String(err) }, 'watchdog tick failed'));
  }, cfg.intervalMs);
  interval.unref?.();

  return () => clearInterval(interval);
}

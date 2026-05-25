import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { AlertEngine } from '../alerts/rules.js';
import type { Logger } from '../utils/logger.js';

/**
 * Имя файла НЕ "cold-mark-failed" / "cold-recovery" специально —
 * в v3+ persisted active-state не используется, и старое имя провоцировало
 * бы регрессию идеи cold-replay.
 *
 * На старте процесса:
 *   1) Если был писаный pid-файл — посчитать предыдущий uptime, отправить alert.
 *   2) Записать новый pid и время старта.
 *
 * При SIGTERM (graceful shutdown) — обновить pid-файл с временем выхода.
 */
export class StartupAlert {
  constructor(
    private readonly stateFilePath: string,
    private readonly alerts: AlertEngine,
    private readonly logger: Logger,
  ) {}

  async fire(): Promise<void> {
    const prevUptimeMs = this.readPrevUptime();
    this.writeCurrentState();
    await this.alerts.onStartup(prevUptimeMs);
  }

  recordShutdown(): void {
    try {
      const startedAt = this.readStartedAt();
      const state = {
        pid: process.pid,
        startedAt,
        stoppedAt: Date.now(),
      };
      writeFileSync(this.stateFilePath, JSON.stringify(state), 'utf8');
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'failed to write shutdown state');
    }
  }

  private readPrevUptime(): number | null {
    try {
      if (!existsSync(this.stateFilePath)) return null;
      const raw = readFileSync(this.stateFilePath, 'utf8');
      const parsed = JSON.parse(raw) as { startedAt?: number; stoppedAt?: number };
      if (
        typeof parsed.startedAt === 'number' &&
        typeof parsed.stoppedAt === 'number' &&
        parsed.stoppedAt >= parsed.startedAt
      ) {
        return parsed.stoppedAt - parsed.startedAt;
      }
      if (typeof parsed.startedAt === 'number') {
        // Не было записи о shutdown — значит, был crash.
        return Date.now() - parsed.startedAt;
      }
      return null;
    } catch {
      return null;
    }
  }

  private readStartedAt(): number {
    try {
      const raw = readFileSync(this.stateFilePath, 'utf8');
      const parsed = JSON.parse(raw) as { startedAt?: number };
      if (typeof parsed.startedAt === 'number') return parsed.startedAt;
    } catch {
      // ignore
    }
    return Date.now();
  }

  private writeCurrentState(): void {
    try {
      mkdirSync(dirname(this.stateFilePath), { recursive: true });
      const state = { pid: process.pid, startedAt: Date.now() };
      writeFileSync(this.stateFilePath, JSON.stringify(state), 'utf8');
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'failed to write startup state');
    }
  }
}

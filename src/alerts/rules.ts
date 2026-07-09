import type { Config } from '../config.js';
import type { RequestStatus, RequestsRepo } from '../storage/requests-repo.js';
import { AlertCooldown } from './dedup.js';
import { TelegramSender } from './telegram.js';
import type { Logger } from '../utils/logger.js';

export type AlertKind =
  | 'openrouter_401'
  | 'openrouter_402'
  | 'openrouter_unreachable'
  | 'openrouter_recovered'
  | 'error_streak'
  | 'high_error_rate'
  | 'long_request'
  | 'stuck_request'
  | 'proxy_restarted'
  | 'disk_low'
  | 'quota_warning'
  | 'daily_digest';

const COOLDOWNS_MS = new Map<AlertKind, number>([
  ['openrouter_401', 0],
  ['openrouter_402', 0],
  ['openrouter_unreachable', 5 * 60_000],
  ['openrouter_recovered', 0],
  ['error_streak', 10 * 60_000],
  ['high_error_rate', 30 * 60_000],
  ['long_request', 0],
  ['stuck_request', 0],
  ['proxy_restarted', 0],
  ['disk_low', 24 * 60 * 60_000],
  ['quota_warning', 60 * 60_000],
  ['daily_digest', 0],
]);

export interface ObservedEvent {
  type: 'request_completed';
  status: RequestStatus;
  httpStatus: number | null;
  latencyMs: number | null;
  errorCode: string | null;
  clientId?: string | null;
}

export class AlertEngine {
  private readonly cooldown = new AlertCooldown(COOLDOWNS_MS);
  // Пер-клиентские серии ошибок: единый счётчик размывался успехом другого арендатора.
  private readonly streaks = new Map<string, number>();
  private readonly hadErrors = new Map<string, boolean>();

  constructor(
    private readonly config: Config,
    private readonly telegram: TelegramSender,
    private readonly repo: RequestsRepo,
    private readonly logger: Logger,
  ) {}

  async onStartup(prevUptimeMs: number | null): Promise<void> {
    const uptimeNote = prevUptimeMs !== null
      ? `\nПредыдущая сессия: ${Math.round(prevUptimeMs / 1000)}s`
      : '';
    await this.fire('proxy_restarted', `🔄 <b>proxy_llm</b> запущен${uptimeNote}`);
  }

  async onEvent(ev: ObservedEvent): Promise<void> {
    const isError = ev.status !== 'success';

    if (ev.httpStatus === 401 && (ev.errorCode === '401' || ev.errorCode === 'unauthorized')) {
      await this.fire(
        'openrouter_401',
        '🚨 <b>OpenRouter 401</b> — ключ невалиден. Срочно проверьте OPENROUTER_API_KEY.',
      );
    } else if (ev.httpStatus === 402) {
      await this.fire(
        'openrouter_402',
        '🚨 <b>OpenRouter 402</b> — закончились кредиты. Пополните баланс.',
      );
    }

    if (
      ev.latencyMs !== null &&
      ev.latencyMs > this.config.ALERT_LONG_REQUEST_MS
    ) {
      await this.fire(
        'long_request',
        `🐢 Долгий запрос: ${Math.round(ev.latencyMs / 1000)}s (статус: ${ev.status})`,
      );
    }

    const cid = ev.clientId ?? 'default';
    if (isError) {
      const n = (this.streaks.get(cid) ?? 0) + 1;
      this.streaks.set(cid, n);
      this.hadErrors.set(cid, true);
      if (n >= this.config.ALERT_ERROR_STREAK_THRESHOLD) {
        await this.fire(
          'error_streak',
          `⚠️ Серия ошибок (${cid}): ${n} подряд. Последняя: ${ev.status} / ${ev.errorCode ?? '—'}`,
          `error_streak:${cid}`,
        );
      }
    } else {
      if (
        (this.hadErrors.get(cid) ?? false) &&
        (this.streaks.get(cid) ?? 0) >= this.config.ALERT_ERROR_STREAK_THRESHOLD
      ) {
        await this.fire('openrouter_recovered', `✅ ${cid}: восстановление после серии ошибок.`);
      }
      this.streaks.set(cid, 0);
      this.hadErrors.set(cid, false);
    }

    await this.checkErrorRate();
  }

  async onStuckRequest(requestId: string, elapsedMs: number): Promise<void> {
    await this.fire(
      'stuck_request',
      `🔥 Зависший запрос ${requestId}: ${Math.round(elapsedMs / 1000)}s — abort.`,
    );
  }

  async onDiskLow(freeBytes: number): Promise<void> {
    await this.fire(
      'disk_low',
      `💾 Мало места на диске: ${Math.round(freeBytes / 1024 / 1024)} МБ свободно.`,
    );
  }

  async onUnreachable(): Promise<void> {
    await this.fire('openrouter_unreachable', '📡 OpenRouter недоступен (DNS/TCP ошибки подряд).');
  }

  async sendDailyDigest(): Promise<void> {
    const since = Date.now() - 24 * 60 * 60_000;
    const agg = this.repo.aggregateSince(since);
    const p95 = this.repo.p95LatencySince(since);
    const text = [
      '📊 <b>proxy_llm</b> — дневная сводка (24ч)',
      `Запросов: ${agg.total} (успешных: ${agg.success}, ошибок: ${agg.errors})`,
      `Средняя latency: ${agg.avg_latency_ms !== null ? Math.round(agg.avg_latency_ms) + ' ms' : '—'}`,
      `p95 latency: ${p95 !== null ? p95 + ' ms' : '—'}`,
      `Токенов всего: ${agg.total_tokens ?? 0}`,
    ].join('\n');
    await this.fire('daily_digest', text);
  }

  private async checkErrorRate(): Promise<void> {
    const window = this.config.ALERT_ERROR_RATE_WINDOW;
    const statuses = this.repo.recentStatuses(window);
    if (statuses.length < Math.max(20, Math.floor(window / 2))) return;
    const errors = statuses.filter((s) => s !== 'success').length;
    const rate = errors / statuses.length;
    if (rate > this.config.ALERT_ERROR_RATE_THRESHOLD) {
      await this.fire(
        'high_error_rate',
        `📉 Высокий error rate: ${Math.round(rate * 100)}% за последние ${statuses.length} запросов.`,
      );
    }
  }

  private async fire(kind: AlertKind, text: string, instanceKey?: string): Promise<void> {
    const now = Date.now();
    const key = instanceKey ?? kind;
    if (!this.cooldown.shouldSend(kind, now, key)) return;
    this.cooldown.markSent(kind, now, key);
    this.logger.info({ alert: kind, key }, 'alert fired');
    await this.telegram.send(text);
  }
}

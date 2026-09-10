import type { Config } from '../config.js';
import { NON_ERROR_STATUSES, type Contour, type RequestStatus, type RequestsRepo } from '../storage/requests-repo.js';
import type { BillingRepo } from '../storage/billing-repo.js';
import { AlertCooldown } from './dedup.js';
import { TelegramSender } from './telegram.js';
import type { Logger } from '../utils/logger.js';
import { todayIn, addDays } from '../billing/billing-time.js';

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
  | 'daily_digest'
  | 'admin_login_failures'
  | 'admin_session_reuse'
  | 'agent_auth_failures';

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
  ['admin_login_failures', 30 * 60_000],
  ['admin_session_reuse', 0],
  ['agent_auth_failures', 30 * 60_000],
]);

/** Telegram parse_mode=HTML: всё, что пришло из данных (имена провайдеров, логины), экранируем. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const CONTOUR_TITLE: Record<Contour, string> = { site: 'сайты', agent: 'агенты' };

export interface ObservedEvent {
  type: 'request_completed';
  status: RequestStatus;
  httpStatus: number | null;
  latencyMs: number | null;
  errorCode: string | null;
  clientId?: string | null;
  /** По умолчанию 'site'. */
  contour?: Contour;
  /** Порог «долгого запроса» контура; по умолчанию ALERT_LONG_REQUEST_MS. */
  longRequestThresholdMs?: number;
  /** Кто ответил 401/402: по умолчанию 'OpenRouter'. */
  upstreamLabel?: string;
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
    private readonly billing?: BillingRepo,
  ) {}

  async onStartup(prevUptimeMs: number | null): Promise<void> {
    const uptimeNote = prevUptimeMs !== null
      ? `\nПредыдущая сессия: ${Math.round(prevUptimeMs / 1000)}s`
      : '';
    await this.fire('proxy_restarted', `🔄 <b>proxy_llm</b> запущен${uptimeNote}`);
  }

  async onEvent(ev: ObservedEvent): Promise<void> {
    const isError = !NON_ERROR_STATUSES.has(ev.status);
    const contour = ev.contour ?? 'site';
    const label = ev.upstreamLabel ?? 'OpenRouter';
    const ownKey = label === 'OpenRouter';

    if (ev.httpStatus === 401 && (ev.errorCode === '401' || ev.errorCode === 'unauthorized')) {
      await this.fire(
        'openrouter_401',
        ownKey
          ? '🚨 <b>OpenRouter 401</b> — ключ невалиден. Срочно проверьте OPENROUTER_API_KEY.'
          : `🚨 <b>${esc(label)} 401</b> — ключ провайдера невалиден. Проверьте его в админке (Провайдеры).`,
        `openrouter_401:${label}`,
      );
    } else if (ev.httpStatus === 402) {
      await this.fire(
        'openrouter_402',
        ownKey
          ? '🚨 <b>OpenRouter 402</b> — закончились кредиты. Пополните баланс.'
          : `🚨 <b>${esc(label)} 402</b> — у провайдера закончились кредиты.`,
        `openrouter_402:${label}`,
      );
    }

    if (
      ev.latencyMs !== null &&
      ev.latencyMs > (ev.longRequestThresholdMs ?? this.config.ALERT_LONG_REQUEST_MS)
    ) {
      await this.fire(
        'long_request',
        `🐢 Долгий запрос: ${Math.round(ev.latencyMs / 1000)}s (статус: ${ev.status})`,
      );
    }

    // Отмена пользователем — не ошибка и не успех: серию не продолжает и не обрывает.
    if (ev.status === 'client_aborted') {
      await this.checkErrorRate(contour);
      return;
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

    await this.checkErrorRate(contour);
  }

  async onAdminLoginFailures(login: string, ip: string, count: number): Promise<void> {
    await this.fire(
      'admin_login_failures',
      `🔐 Админка: ${count} неудачных входов для «${esc(login)}», последний IP ${esc(ip)}.`,
      `admin_login_failures:${login.toLowerCase()}`,
    );
  }

  async onAdminSessionReuse(login: string, ip: string): Promise<void> {
    await this.fire(
      'admin_session_reuse',
      `🚨 Админка: повторно предъявлен уже использованный refresh-токен «${esc(login)}» (IP ${esc(ip)}). ` +
        'Сессия отозвана — возможна кража cookie.',
    );
  }

  async onAgentAuthFailures(count: number, windowMs: number, topIps: readonly string[]): Promise<void> {
    await this.fire(
      'agent_auth_failures',
      `🔑 Агентский API: ${count} запросов с неверным токеном за ${Math.round(windowMs / 60_000)} мин. ` +
        `IP: ${topIps.map(esc).join(', ') || '—'}`,
    );
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
    // Оперативная часть — контур сайтов, как и раньше; агенты отдельным блоком: их стримы
    // длятся минутами и исказили бы latency порталов.
    const agg = this.repo.aggregateSince(since, undefined, 'site');
    const p95 = this.repo.p95LatencySince(since, 500, 'site');
    const lines = [
      '📊 <b>proxy_llm</b> — дневная сводка (24ч)',
      `Запросов: ${agg.total} (успешных: ${agg.success}, ошибок: ${agg.errors})`,
      `Средняя latency: ${agg.avg_latency_ms !== null ? Math.round(agg.avg_latency_ms) + ' ms' : '—'}`,
      `p95 latency: ${p95 !== null ? p95 + ' ms' : '—'}`,
      `Токенов всего: ${agg.total_tokens ?? 0}`,
    ];
    if (agg.errors > 0) {
      const breakdown = this.repo
        .errorBreakdownSince(since, 'site')
        .slice(0, 8)
        .map((r) => `${r.status}${r.error_code ? '/' + r.error_code : ''} ×${r.n}`)
        .join(', ');
      if (breakdown) lines.push(`Ошибки: ${breakdown}`);
    }
    lines.push(...this.agentLines(since));
    lines.push(...this.billingLines());
    await this.fire('daily_digest', lines.join('\n'));
  }

  private agentLines(since: number): string[] {
    const a = this.repo.aggregateSince(since, undefined, 'agent');
    if (a.total === 0) return [];
    const aborted = a.total - (a.success ?? 0) - (a.errors ?? 0);
    return [
      '',
      '🤖 Агенты (24ч)',
      `Запросов: ${a.total} (успешных: ${a.success ?? 0}, ошибок: ${a.errors ?? 0}, отменено: ${aborted})`,
    ];
  }

  /**
   * Денежная часть сводки: завершённые сутки, текущий день с пометкой «неполный» и rolling 30.
   * Факт и оценка выводятся раздельно — смешивать измеренное с расчётным нельзя.
   */
  private billingLines(): string[] {
    if (!this.billing) return [];
    const tz = this.config.BILLING_TIMEZONE;
    const today = todayIn(tz);
    const yesterday = addDays(today, -1);

    const y = this.billing.spendTotals(yesterday, yesterday);
    const t = this.billing.spendTotals(today, today);
    const m = this.billing.spendTotals(addDays(today, -29), today);

    const usd = (v: number): string => '$' + v.toFixed(4);
    const approx = (v: number): string => (v > 0 ? ` (+≈${usd(v)} оценка)` : '');

    const lines = [
      '',
      `💰 Расходы (${tz})`,
      `Вчера (${yesterday}): ${usd(y.cost_actual_usd)}${approx(y.cost_approx_usd)} · ` +
        `${y.input_tokens} in / ${y.output_tokens} out`,
      `Сегодня (${today}, неполные сутки): ${usd(t.cost_actual_usd)}${approx(t.cost_approx_usd)}`,
      `За 30 суток: ${usd(m.cost_actual_usd)}${approx(m.cost_approx_usd)}`,
    ];
    const agentY = this.billing.spendTotals(yesterday, yesterday, 'agent');
    if (agentY.upstream_attempts > 0) {
      lines.push(`  в т.ч. агенты вчера: ${usd(agentY.cost_actual_usd)}${approx(agentY.cost_approx_usd)}`);
    }

    const perClient = this.billing
      .spendByClient(yesterday, yesterday)
      .filter((r) => r.cost_actual_usd > 0 || r.upstream_attempts > 0)
      .map((r) => `  ${r.client_id ?? '—'}: ${usd(r.cost_actual_usd)} (${r.executions} выз.)`);
    if (perClient.length > 0) lines.push('По клиентам за вчера:', ...perClient);

    if (m.missing_rows > 0) {
      lines.push(`⚠️ Попыток без стоимости за 30 суток: ${m.missing_rows}`);
    }

    // Отставание синхронизации означает, что оценка считается по устаревшему прайсу.
    const sync = this.billing.lastSuccessfulSync();
    if (!sync) {
      lines.push('⚠️ Синхронизация цен ещё ни разу не проходила');
    } else if (sync.run_day < yesterday) {
      lines.push(`⚠️ Цены не обновлялись с ${sync.run_day}`);
    }

    return lines;
  }

  /** Error rate считается по контуру: ошибки провайдера агентов не должны будить про порталы. */
  private async checkErrorRate(contour: Contour): Promise<void> {
    const window = this.config.ALERT_ERROR_RATE_WINDOW;
    const statuses = this.repo.recentStatuses(window, contour).filter((s) => s !== 'client_aborted');
    if (statuses.length < Math.max(20, Math.floor(window / 2))) return;
    const errors = statuses.filter((s) => !NON_ERROR_STATUSES.has(s)).length;
    const rate = errors / statuses.length;
    if (rate > this.config.ALERT_ERROR_RATE_THRESHOLD) {
      const who = contour === 'site' ? '' : ` (${CONTOUR_TITLE[contour]})`;
      await this.fire(
        'high_error_rate',
        `📉 Высокий error rate${who}: ${Math.round(rate * 100)}% за последние ${statuses.length} запросов.`,
        `high_error_rate:${contour}`,
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

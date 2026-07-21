import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';
import type { RequestsRepo } from '../storage/requests-repo.js';
import type { BillingRepo, SpendTotals } from '../storage/billing-repo.js';
import { registerBasicAuth } from '../auth/basic-auth.js';
import type { Config } from '../config.js';
import type { ActiveMetrics } from './chat-completions.js';
import { todayIn, addDays, daysBetween, isValidDay } from '../billing/billing-time.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Верхняя граница периода: защита от запроса, который вытащит всю историю разом. */
const MAX_RANGE_DAYS = 366;

export interface DashboardDeps {
  config: Config;
  repo: RequestsRepo;
  billing: BillingRepo;
  activeMetrics: ActiveMetrics;
}

interface RangeError {
  error: { code: string; message: string };
}

/** Разбирает from/to из querystring. По умолчанию — последние 30 суток включительно. */
function resolveRange(
  query: unknown,
  timezone: string,
): { from: string; to: string } | RangeError {
  const q = (query ?? {}) as Record<string, unknown>;
  const today = todayIn(timezone);
  const to = q.to === undefined || q.to === '' ? today : q.to;
  const from = q.from === undefined || q.from === '' ? addDays(String(to), -29) : q.from;

  if (!isValidDay(from) || !isValidDay(to)) {
    return { error: { code: 'invalid_request', message: 'from/to must be YYYY-MM-DD dates' } };
  }
  const span = daysBetween(from, to);
  if (span < 0) {
    return { error: { code: 'invalid_request', message: 'from must not be after to' } };
  }
  if (span + 1 > MAX_RANGE_DAYS) {
    return {
      error: { code: 'invalid_request', message: `range must not exceed ${MAX_RANGE_DAYS} days` },
    };
  }
  return { from, to };
}

function isRangeError(v: { from: string; to: string } | RangeError): v is RangeError {
  return 'error' in v;
}

/** Собирает всё, что нужно и HTML-странице, и JSON-эндпоинту. */
function buildBillingReport(deps: DashboardDeps, from: string, to: string) {
  const tz = deps.config.BILLING_TIMEZONE;
  const today = todayIn(tz);
  const yesterday = addDays(today, -1);
  const startedAt = deps.billing.accountingStartedAt();

  return {
    from,
    to,
    timezone: tz,
    today: deps.billing.spendTotals(today, today),
    yesterday: deps.billing.spendTotals(yesterday, yesterday),
    totals: deps.billing.spendTotals(from, to),
    retryWaste: deps.billing.retryWasteUsd(from, to),
    byClient: deps.billing.spendByClient(from, to),
    byModel: deps.billing.spendByModel(from, to),
    byDayClient: deps.billing.spendByDayClient(from, to),
    priceSync: deps.billing.lastSuccessfulSync(),
    accountingStartedAt: startedAt === null ? null : new Date(startedAt).toISOString().slice(0, 10),
  };
}

/** Деньги округляем только на выводе; 6 знаков хватает для сумм порядка $0.000001. */
function fmtUsd(v: number): string {
  return v.toFixed(6);
}

function shortTotals(t: SpendTotals) {
  return {
    costActualUsd: t.cost_actual_usd,
    costApproxUsd: t.cost_approx_usd,
    executions: t.executions,
    upstreamAttempts: t.upstream_attempts,
    inputTokens: t.input_tokens,
    outputTokens: t.output_tokens,
    cachedTokens: t.cached_tokens,
    missingRows: t.missing_rows,
    approxRows: t.approx_rows,
  };
}

export async function registerDashboard(
  app: FastifyInstance,
  deps: DashboardDeps,
): Promise<void> {
  await registerBasicAuth(app, {
    user: deps.config.DASHBOARD_USER,
    password: deps.config.DASHBOARD_BASIC_AUTH_PASS,
  });

  const tplPath = resolve(__dirname, '..', 'views', 'dashboard.eta');
  const tplText = readFileSync(tplPath, 'utf8');
  const billingTplText = readFileSync(resolve(__dirname, '..', 'views', 'billing.eta'), 'utf8');
  const eta = new Eta({ autoEscape: true });

  app.get(
    '/dashboard',
    { onRequest: app.basicAuth },
    async (_req, reply) => {
      const now = Date.now();
      const aggDay = deps.repo.aggregateSince(now - 24 * 60 * 60_000);
      const aggHour = deps.repo.aggregateSince(now - 60 * 60_000);
      const p95Day = deps.repo.p95LatencySince(now - 24 * 60 * 60_000);
      const recent = deps.repo.listRecent(100);

      const html = eta.renderString(tplText, {
        aggDay,
        aggHour,
        p95Day,
        recent,
        activeCount: deps.activeMetrics.size(),
        generatedAt: new Date().toISOString(),
        formatTs: (ts: number | null) => (ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 19) : '—'),
      });

      reply.header('content-type', 'text/html; charset=utf-8');
      reply.send(html);
    },
  );

  // JSON-эндпоинт для скриптов и UptimeRobot-style проверок (под той же auth).
  app.get(
    '/dashboard/stats.json',
    { onRequest: app.basicAuth },
    async (_req, reply) => {
      const now = Date.now();
      const tz = deps.config.BILLING_TIMEZONE;
      const today = todayIn(tz);
      const last30From = addDays(today, -29);
      const sync = deps.billing.lastSuccessfulSync();

      reply.send({
        day: deps.repo.aggregateSince(now - 24 * 60 * 60_000),
        hour: deps.repo.aggregateSince(now - 60 * 60_000),
        p95DayMs: deps.repo.p95LatencySince(now - 24 * 60 * 60_000),
        activeCount: deps.activeMetrics.size(),
        perClientDay: deps.repo.perClientAggregate(now - 24 * 60 * 60_000),
        // Additive-блок: существующие ключи не трогаем, на них могут быть завязаны скрипты.
        billing: {
          timezone: tz,
          today: shortTotals(deps.billing.spendTotals(today, today)),
          yesterday: shortTotals(deps.billing.spendTotals(addDays(today, -1), addDays(today, -1))),
          last30d: shortTotals(deps.billing.spendTotals(last30From, today)),
          perClientLast30d: deps.billing.spendByClient(last30From, today).map((r) => ({
            clientId: r.client_id,
            ...shortTotals(r),
          })),
          priceSync: sync
            ? {
                lastOkDay: sync.run_day,
                modelsSeen: sync.models_seen,
                versionsWritten: sync.versions_written,
                at: sync.started_at,
              }
            : null,
        },
      });
    },
  );

  app.get(
    '/dashboard/billing',
    { onRequest: app.basicAuth },
    async (req, reply) => {
      const range = resolveRange(req.query, deps.config.BILLING_TIMEZONE);
      if (isRangeError(range)) {
        reply.code(400).send(range);
        return;
      }

      const html = eta.renderString(billingTplText, {
        ...buildBillingReport(deps, range.from, range.to),
        generatedAt: new Date().toISOString(),
        fmt: fmtUsd,
      });
      reply.header('content-type', 'text/html; charset=utf-8');
      reply.send(html);
    },
  );

  app.get(
    '/dashboard/billing.json',
    { onRequest: app.basicAuth },
    async (req, reply) => {
      const range = resolveRange(req.query, deps.config.BILLING_TIMEZONE);
      if (isRangeError(range)) {
        reply.code(400).send(range);
        return;
      }
      reply.send(buildBillingReport(deps, range.from, range.to));
    },
  );
}

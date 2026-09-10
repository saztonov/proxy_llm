import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminCtx } from '../ctx.js';
import { parseOr400, sendError } from '../validation.js';
import { resolveRange } from '../range.js';
import { todayIn, addDays } from '../../billing/billing-time.js';
import type { SpendTotals } from '../../storage/billing-repo.js';
import type { AggregateRow, Contour } from '../../storage/requests-repo.js';

const BY = ['client', 'model', 'department', 'employee', 'agent-token', 'provider', 'site-token', 'day-client', 'day-department'] as const;
const spendQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  by: z.enum(BY).default('client'),
  contour: z.enum(['site', 'agent', '']).optional(),
});
const requestsQuery = z.object({
  contour: z.enum(['site', 'agent', '']).optional(),
  clientId: z.string().max(100).optional(),
  tokenId: z.coerce.number().int().positive().optional(),
  departmentId: z.coerce.number().int().positive().optional(),
  employeeId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  beforeId: z.coerce.number().int().positive().optional(),
});

/** SUM по пустому множеству в SQLite — NULL; для интерфейса это ноль. */
function totals(t: SpendTotals) {
  return {
    cost_actual_usd: t.cost_actual_usd ?? 0, cost_approx_usd: t.cost_approx_usd ?? 0, executions: t.executions ?? 0,
    upstream_attempts: t.upstream_attempts ?? 0, input_tokens: t.input_tokens ?? 0, output_tokens: t.output_tokens ?? 0,
    missing_rows: t.missing_rows ?? 0, approx_rows: t.approx_rows ?? 0,
  };
}

function agg(a: AggregateRow) {
  return { total: a.total ?? 0, success: a.success ?? 0, errors: a.errors ?? 0, avg_latency_ms: a.avg_latency_ms, total_tokens: a.total_tokens };
}

function contourOf(v: string | undefined): Contour | undefined {
  return v === 'site' || v === 'agent' ? v : undefined;
}

function parseJson(s: string | null): unknown {
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

type SpendRow = { key: string; label: string } & ReturnType<typeof totals>;

export async function registerStatsRoutes(app: FastifyInstance, ctx: AdminCtx): Promise<void> {
  const { repos } = ctx;
  const tz = ctx.config.BILLING_TIMEZONE;

  app.get('/stats/summary', async (_req, reply) => {
    const now = Date.now();
    const day = now - 86_400_000;
    const hour = now - 3_600_000;
    const ops = (c: Contour) => ({
      day: agg(repos.requests.aggregateSince(day, undefined, c)),
      hour: agg(repos.requests.aggregateSince(hour, undefined, c)),
      p95DayMs: repos.requests.p95LatencySince(day, 500, c),
    });
    const split = (from: string, to: string) => ({
      site: totals(repos.billing.spendTotals(from, to, 'site')),
      agent: totals(repos.billing.spendTotals(from, to, 'agent')),
      total: totals(repos.billing.spendTotals(from, to)),
    });
    const today = todayIn(tz);
    const yesterday = addDays(today, -1);
    const sync = repos.billing.lastSuccessfulSync();
    const started = repos.billing.accountingStartedAt();
    reply.send({
      generatedAt: now,
      sites: ops('site'),
      agents: ops('agent'),
      active: { sites: ctx.activeMetrics.size(), agents: ctx.agentActiveMetrics.size() },
      fairness: { sites: ctx.fairness.snapshot(), agents: ctx.agentFairness.snapshot() },
      spend: { today: split(today, today), yesterday: split(yesterday, yesterday), last30d: split(addDays(today, -29), today) },
      priceSync: sync ? { lastOkDay: sync.run_day, at: sync.started_at } : null,
      accountingStartedAt: started === null ? null : new Date(started).toISOString().slice(0, 10),
    });
  });

  app.get('/stats/spend', async (req, reply) => {
    const q = parseOr400(spendQuery, req.query, reply);
    if (!q) return;
    const range = resolveRange(q, tz);
    if (!range.ok) return sendError(reply, 400, 'invalid_request', range.message);
    const { from, to } = range;
    const contour = contourOf(q.contour);
    const b = repos.billing;
    const row = (key: unknown, label: string, t: SpendTotals): SpendRow => ({ key: String(key ?? '—'), label, ...totals(t) });
    // Группировки по справочнику агентов имеют смысл только в агентском контуре, по токенам сайтов — в сайтовом.
    let scope: Contour | undefined = contour;
    let rows: SpendRow[];
    switch (q.by) {
      case 'client':
        rows = b.spendByClient(from, to, contour).map((r) => row(r.client_id, r.client_id ?? '—', r));
        break;
      case 'model':
        rows = b.spendByModel(from, to, contour).map((r) => row(r.model, r.model ?? '—', r));
        break;
      case 'day-client':
        rows = b.spendByDayClient(from, to, contour).map((r) => row(`${r.billing_day}|${r.client_id}`, `${r.billing_day} · ${r.client_id ?? '—'}`, r));
        break;
      case 'department':
        scope = 'agent';
        rows = b.spendByDepartment(from, to).map((r) => row(r.department_id, r.department_name ?? '—', r));
        break;
      case 'employee':
        scope = 'agent';
        rows = b.spendByEmployee(from, to).map((r) => row(r.employee_id, r.employee_name ? `${r.employee_name} (${r.employee_login})` : '—', r));
        break;
      case 'agent-token':
        scope = 'agent';
        rows = b.spendByAgentToken(from, to).map((r) => row(r.token_id, r.token_prefix ? `${r.token_prefix}… ${r.token_label ?? ''}`.trim() : '—', r));
        break;
      case 'provider':
        scope = 'agent';
        rows = b.spendByProvider(from, to).map((r) => row(r.provider_id, r.provider_name ?? '—', r));
        break;
      case 'site-token':
        scope = 'site';
        rows = b.spendBySiteToken(from, to).map((r) =>
          row(`${r.client_id}|${r.token_id}`, `${r.client_id ?? '—'} · ${r.token_prefix ?? (r.token_id !== null ? '#' + r.token_id : 'без токена из БД')}`, r));
        break;
      case 'day-department':
        scope = 'agent';
        rows = b.spendByDayDepartment(from, to).map((r) => row(`${r.billing_day}|${r.department_id}`, `${r.billing_day} · ${r.department_name ?? '—'}`, r));
        break;
      default:
        rows = [];
    }
    reply.send({ from, to, timezone: tz, by: q.by, contour: scope ?? null, totals: totals(b.spendTotals(from, to, scope)), rows });
  });

  app.get('/requests', async (req, reply) => {
    const q = parseOr400(requestsQuery, req.query, reply);
    if (!q) return;
    const contour = contourOf(q.contour);
    reply.send({
      requests: repos.requests.listRecentFiltered({
        limit: q.limit,
        ...(contour ? { contour } : {}),
        ...(q.clientId ? { clientId: q.clientId } : {}),
        ...(q.tokenId ? { tokenId: q.tokenId } : {}),
        ...(q.departmentId ? { departmentId: q.departmentId } : {}),
        ...(q.employeeId ? { employeeId: q.employeeId } : {}),
      }),
    });
  });

  app.get('/audit', async (req, reply) => {
    const q = parseOr400(auditQuery, req.query, reply);
    if (!q) return;
    reply.send({
      entries: repos.audit.listRecent(q.limit, q.beforeId ?? null).map((e) => ({
        id: e.id, ts: e.ts, adminLogin: e.admin_login, ip: e.ip, action: e.action,
        entityType: e.entity_type, entityId: e.entity_id, details: parseJson(e.details_json),
      })),
    });
  });
}

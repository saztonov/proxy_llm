import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Eta } from 'eta';
import type { RequestsRepo } from '../storage/requests-repo.js';
import { registerBasicAuth } from '../auth/basic-auth.js';
import type { Config } from '../config.js';
import type { ActiveMetrics } from './chat-completions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface DashboardDeps {
  config: Config;
  repo: RequestsRepo;
  activeMetrics: ActiveMetrics;
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
      reply.send({
        day: deps.repo.aggregateSince(now - 24 * 60 * 60_000),
        hour: deps.repo.aggregateSince(now - 60 * 60_000),
        p95DayMs: deps.repo.p95LatencySince(now - 24 * 60 * 60_000),
        activeCount: deps.activeMetrics.size(),
      });
    },
  );
}

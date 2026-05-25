import type { FastifyInstance } from 'fastify';
import { lookup } from 'node:dns/promises';
import type { DbHandle } from '../storage/db.js';
import type { Config } from '../config.js';

export interface HealthDeps {
  db: DbHandle;
  config: Config;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  deps: HealthDeps,
): Promise<void> {
  // Публичный liveness: МАКСИМАЛЬНО ПУСТОЙ ответ. Никаких версий/DB/queue-метрик.
  app.get('/healthz', async (_req, reply) => {
    reply.code(200).send({ status: 'ok' });
  });

  // Internal readiness. НЕ делает chat completion в OpenRouter (никаких платных probe).
  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = {};

    try {
      deps.db.db.prepare('SELECT 1').get();
      checks.db = 'ok';
    } catch {
      checks.db = 'fail';
    }

    try {
      const url = new URL(deps.config.OPENROUTER_BASE_URL);
      await lookup(url.hostname);
      checks.dns = 'ok';
    } catch {
      checks.dns = 'fail';
    }

    const allOk = Object.values(checks).every((v) => v === 'ok');
    reply.code(allOk ? 200 : 503).send({ ready: allOk, checks });
  });
}

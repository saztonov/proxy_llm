import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminCtx } from '../ctx.js';
import { parseOr400, sendError, modelSlug } from '../validation.js';
import { actorOf } from '../audit.js';
import { agentBaseUrl } from './agent-tokens.js';

const defaultsBody = z.object({
  providerId: z.number().int().positive().nullable(),
  model: modelSlug.nullable(),
  maxConcurrency: z.number().int().min(1).max(200).nullable(),
  maxPending: z.number().int().min(1).max(1000).nullable(),
}).strict();

export async function registerSettingsRoutes(app: FastifyInstance, ctx: AdminCtx): Promise<void> {
  const c = ctx.config;

  app.get('/settings', async (req, reply) => {
    reply.send({
      agentDefaults: ctx.repos.settings.agentDefaults(),
      env: {
        agentPrincipalMaxConcurrency: c.AGENT_PRINCIPAL_MAX_CONCURRENCY,
        agentPrincipalMaxPending: c.AGENT_PRINCIPAL_MAX_PENDING,
        agentQueueConcurrency: c.AGENT_QUEUE_CONCURRENCY,
        agentQueueMaxPending: c.AGENT_QUEUE_MAX_PENDING,
        agentRateLimitMax: c.AGENT_RATE_LIMIT_MAX,
        agentRateLimitWindowMs: c.AGENT_RATE_LIMIT_WINDOW_MS,
      },
      agentBaseUrl: agentBaseUrl(req),
    });
  });

  app.put('/settings/agent-defaults', async (req, reply) => {
    const b = parseOr400(defaultsBody, req.body, reply);
    if (!b) return;
    if ((b.providerId === null) !== (b.model === null)) {
      return sendError(reply, 400, 'invalid_request', 'validation failed', { issues: [{ path: 'model', message: 'providerId and model go together' }] });
    }
    if (b.providerId !== null) {
      const p = ctx.repos.providers.get(b.providerId);
      if (!p || p.enabled !== 1) {
        return sendError(reply, 400, 'invalid_request', 'validation failed', { issues: [{ path: 'providerId', message: 'provider not found or disabled' }] });
      }
    }
    ctx.change(() => {
      ctx.repos.settings.setAgentDefaults(b, Date.now());
      ctx.audit.record(actorOf(req), 'settings.update', 'settings', 'agent_defaults', { providerId: b.providerId, model: b.model });
    });
    reply.send({ agentDefaults: ctx.repos.settings.agentDefaults() });
  });
}

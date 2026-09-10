import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { AgentPrincipal, AgentRegistry } from '../clients/agent-registry.js';
import type { FairnessManager } from '../concurrency/fairness.js';
import type { ActiveMetrics } from '../concurrency/active-metrics.js';
import type { OpenAICompatibleClient } from '../upstream/openai-compatible-client.js';
import type { RequestsRepo } from '../storage/requests-repo.js';
import type { BillingRepo } from '../storage/billing-repo.js';
import type { AlertEngine } from '../alerts/rules.js';

export interface AgentDeps {
  config: Config;
  logger: Logger;
  registry: AgentRegistry;
  /** Отдельный от сайтов инстанс: агенты не выедают очередь порталов и наоборот. */
  fairness: FairnessManager;
  activeMetrics: ActiveMetrics;
  client: OpenAICompatibleClient;
  repo: RequestsRepo;
  billing: BillingRepo;
  alerts: AlertEngine;
}

export interface AgentRequestContext {
  requestId: string;
  /** Ключ в ActiveMetrics — свой, не X-Request-Id клиента (он может повторяться). */
  liveId: string;
  /** Ожидание тела после допуска; снимается, когда тело прочитано или запрос закончился. */
  bodyTimer?: NodeJS.Timeout;
  tsReceived: number;
  principal: AgentPrincipal;
  admitted: boolean;
  released: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    agentContext?: AgentRequestContext;
  }
}

export function clearBodyTimer(req: FastifyRequest): void {
  const ctx = req.agentContext;
  if (ctx?.bodyTimer) {
    clearTimeout(ctx.bodyTimer);
    delete ctx.bodyTimer;
  }
}

/** Идемпотентно: onResponse не срабатывает при обрыве стрима, поэтому зовётся и из finally. */
export function releaseAgentAdmission(req: FastifyRequest, fairness: FairnessManager): void {
  const ctx = req.agentContext;
  if (ctx?.admitted && !ctx.released) {
    ctx.released = true;
    fairness.release(ctx.principal.slotKey);
  }
}

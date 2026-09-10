import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { newRequestId, isValidIdempotencyKey, isValidRequestId } from '../utils/ids.js';
import { ActiveRequests, ActiveDedupFullError } from '../dedup/active-requests.js';
import type { OpenRouterClient } from '../upstream/openrouter-client.js';
import type { ProxyResult } from '../upstream/types.js';
import { createDeadline } from '../upstream/deadline.js';
import { resolvePayer } from '../billing/payer.js';
import type { BillingRepo } from '../storage/billing-repo.js';
import { clientWantedStreaming } from '../upstream/sanitize-payload.js';
import { resolveModel } from '../upstream/resolve-model.js';
import { sanitizeErrorForLog } from '../utils/sanitize-error.js';
import type { RequestsRepo } from '../storage/requests-repo.js';
import type { AlertEngine } from '../alerts/rules.js';
import { makeBearerAuthHook } from '../auth/bearer.js';
import type { ClientConfig } from '../clients/registry.js';
import type { TokenResolver } from '../clients/site-registry.js';
import type { FairnessManager } from '../concurrency/fairness.js';
import { ActiveMetrics } from '../concurrency/active-metrics.js';
import { makeBillingSink } from '../journal/billing-sink.js';
import { recordRequest, type JournalEntry, type JournalOutcome } from '../journal/record-request.js';
import { siteAttribution } from '../journal/attribution.js';

/** Реэкспорт: исторически ActiveMetrics импортировали отсюда (app.ts, тесты). */
export { ActiveMetrics };

declare module 'fastify' {
  interface FastifyRequest {
    proxyContext?: {
      requestId: string;
      idempotencyKey: string | null;
      clientId: string;
      client: ClientConfig;
      tsReceived: number;
      admitted?: boolean;
      released?: boolean;
    };
  }
}

export interface ChatRoutesDeps {
  config: Config;
  logger: Logger;
  registry: TokenResolver;
  fairness: FairnessManager;
  active: ActiveRequests;
  client: OpenRouterClient;
  repo: RequestsRepo;
  billing: BillingRepo;
  alerts: AlertEngine;
  activeMetrics: ActiveMetrics;
}

/** Идемпотентно освобождает admission-слот (onResponse / onRequestAbort). */
function releaseAdmission(req: FastifyRequest, deps: ChatRoutesDeps): void {
  const ctx = req.proxyContext;
  if (ctx?.admitted && !ctx.released) {
    ctx.released = true;
    deps.fairness.release(ctx.clientId);
  }
}

function dedupKeyOf(clientId: string, idempotencyKey: string): string {
  return `${clientId}:${idempotencyKey}`;
}

export async function registerChatRoutes(
  app: FastifyInstance,
  deps: ChatRoutesDeps,
): Promise<void> {
  const bearerAuth = makeBearerAuthHook(deps.registry);

  const CHAT_PATHS = new Set(['/api/v1/chat/completions', '/v1/chat/completions']);

  // Admission control: ДО парсинга body, на onRequest hook.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'POST') return;
    const path = req.url.split('?')[0];
    if (!path || !CHAT_PATHS.has(path)) return;

    // Bearer проверяем здесь же — отказ до чтения body. Резолвит req.authClient.
    await bearerAuth(req, reply);
    if (reply.sent) return;
    const client = req.authClient!;

    const cl = Number(req.headers['content-length'] ?? '0');
    if (cl > 0 && cl > deps.config.BODY_LIMIT_BYTES) {
      reply.code(413).send({
        error: { code: 'payload_too_large', message: `body exceeds ${deps.config.BODY_LIMIT_BYTES} bytes` },
      });
      return;
    }

    const rawIdem = req.headers['x-idempotency-key'];
    const idempotencyKey = typeof rawIdem === 'string' && isValidIdempotencyKey(rawIdem)
      ? rawIdem
      : null;
    const rawReqId = req.headers['x-request-id'];
    const requestId = typeof rawReqId === 'string' && isValidRequestId(rawReqId)
      ? rawReqId
      : newRequestId();

    req.proxyContext = {
      requestId,
      idempotencyKey,
      clientId: client.clientId,
      client,
      tsReceived: Date.now(),
    };

    // Если ключ уже активен (для этого же клиента) — join, admission-слот не занимаем.
    if (idempotencyKey && deps.active.has(dedupKeyOf(client.clientId, idempotencyKey))) return;

    // Синхронная проверка+резервирование (без await между проверкой и ++, закрывает race).
    const admit = deps.fairness.tryAdmit(client);
    if (admit !== 'ok') {
      reply.header('Retry-After', '10');
      const code = admit === 'dedup_full' ? 'dedup_full' : 'queue_full';
      // Раньше отказ не логировался вообще — при инциденте (застрявший admission-слот
      // клиента) в journald не остаётся ни следа причины, только сухая цифра 503 в nginx.
      deps.logger.warn(
        { clientId: client.clientId, requestId, admit },
        'admission rejected: queue full',
      );
      reply.code(503).send({
        error: { code, message: 'proxy queue is full, retry later' },
      });
      return;
    }
    req.proxyContext.admitted = true;
  });

  app.addHook('onResponse', async (req, _reply) => {
    releaseAdmission(req, deps);
  });

  // Клиент оборвал соединение до ответа — освобождаем слот и отменяем upstream.
  app.addHook('onRequestAbort', async (req) => {
    releaseAdmission(req, deps);
    const rid = req.proxyContext?.requestId;
    if (rid) deps.activeMetrics.abort(rid);
  });

  app.post(
    '/api/v1/chat/completions',
    { bodyLimit: deps.config.BODY_LIMIT_BYTES },
    async (req, reply) => handleChat(req, reply, deps),
  );

  // Алиас для legacy-клиентов
  app.post(
    '/v1/chat/completions',
    { bodyLimit: deps.config.BODY_LIMIT_BYTES },
    async (req, reply) => handleChat(req, reply, deps),
  );
}

async function handleChat(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ChatRoutesDeps,
): Promise<void> {
  const ctx = req.proxyContext;
  if (!ctx) {
    reply.code(500).send({ error: { code: 'internal', message: 'missing context' } });
    return;
  }

  const incoming = req.body as Record<string, unknown> | null;
  if (!incoming || typeof incoming !== 'object') {
    reply.code(400).send({ error: { code: 'invalid_request', message: 'body must be JSON object' } });
    return;
  }
  if (clientWantedStreaming(incoming)) {
    reply.code(400).send({
      error: { code: 'streaming_not_supported', message: 'streaming is not supported for OCR proxy' },
    });
    return;
  }
  if (!Array.isArray(incoming.messages) || incoming.messages.length === 0) {
    reply.code(400).send({
      error: { code: 'invalid_request', message: 'messages must be a non-empty array' },
    });
    return;
  }

  // Выбор модели: request.model (если разрешён) → дефолт клиента → глобальный дефолт.
  const modelOutcome = resolveModel(incoming.model, ctx.client);
  if (!modelOutcome.ok) {
    reply.code(400).send({
      error: {
        code: 'model_not_allowed',
        message: 'requested model is not allowed for this client',
        allowed: modelOutcome.allowed,
      },
    });
    return;
  }
  const modelResolution = modelOutcome.resolution;

  const requestBytes = Buffer.byteLength(JSON.stringify(incoming), 'utf8');
  const clientIp = req.ip;

  const deadline = createDeadline(
    ctx.tsReceived,
    deps.config.REQUEST_DEADLINE_MS,
    deps.config.MIN_REMAINING_MS,
  );
  const abort = new AbortController();
  deps.activeMetrics.register(ctx.requestId, ctx.clientId, ctx.admitted === true, deadline.deadlineAt, abort);

  const clientQueue = deps.fairness.queueFor(ctx.clientId);
  // id генерируется здесь, но в ledger попадает только через фабрику — то есть только у
  // запроса, который реально пошёл в OpenRouter. Присоединившийся получит чужой id обратно.
  const candidateExecutionId = newRequestId();
  const onAttempt = makeBillingSink(
    { billing: deps.billing, timezone: deps.config.BILLING_TIMEZONE },
    {
      requestId: ctx.requestId,
      clientId: ctx.clientId,
      payer: resolvePayer(ctx.client, deps.config.OPENROUTER_API_KEY),
      modelRequested: modelResolution.model,
      executionId: candidateExecutionId,
      attribution: siteAttribution(ctx.client.tokenId),
      pricing: 'openrouter',
    },
  );
  const factory = async (): Promise<ProxyResult> =>
    clientQueue.add(() =>
      deps.fairness.globalQueue.add(() =>
        deps.client.execute({
          incoming,
          requestId: ctx.requestId,
          deadline,
          modelResolution,
          clientId: ctx.clientId,
          signal: abort.signal,
          onAttempt,
          ...(ctx.client.openrouterApiKey ? { apiKey: ctx.client.openrouterApiKey } : {}),
        }),
      ),
    ) as Promise<ProxyResult>;

  let result: ProxyResult;
  let executionId = candidateExecutionId;
  let joined = false;
  const entry = (): JournalEntry => ({
    requestId: ctx.requestId,
    idempotencyKey: ctx.idempotencyKey,
    tsReceived: ctx.tsReceived,
    clientId: ctx.clientId,
    source: ctx.client.source,
    clientIp,
    attribution: siteAttribution(ctx.client.tokenId),
    executionId,
    joined,
    modelRequested: modelResolution.model,
    requestBytes,
  });
  try {
    if (ctx.idempotencyKey) {
      const tracked = deps.active.registerOrJoinTracked(
        dedupKeyOf(ctx.clientId, ctx.idempotencyKey),
        candidateExecutionId,
        factory,
      );
      joined = tracked.joined;
      executionId = tracked.executionId;
      result = await tracked.promise;
    } else {
      result = await factory();
    }
  } catch (err) {
    deps.activeMetrics.unregister(ctx.requestId);
    if (err instanceof ActiveDedupFullError) {
      reply.header('Retry-After', '10');
      reply.code(503).send({
        error: { code: 'dedup_full', message: 'active dedup capacity reached' },
      });
      return;
    }
    deps.logger.error({ err: sanitizeErrorForLog(err), requestId: ctx.requestId }, 'handler error');
    recordRequest(deps, entry(), {
      statusCode: 500,
      classification: 'upstream_error',
      attemptCount: 0,
      fallbackUsed: null,
      responseBytes: 0,
    });
    reply.code(500).send({ error: { code: 'internal', message: 'internal proxy error' } });
    return;
  } finally {
    deps.activeMetrics.unregister(ctx.requestId);
  }

  recordRequest(deps, entry(), outcomeOf(result));

  for (const [k, v] of Object.entries(result.headers)) {
    if (v !== undefined) reply.header(k, v);
  }
  reply.code(result.statusCode);
  reply.send(result.bodyText);
}

function outcomeOf(result: ProxyResult): JournalOutcome {
  return {
    statusCode: result.statusCode,
    classification: result.classification,
    attemptCount: result.attemptCount,
    fallbackUsed: result.fallbackUsed,
    responseBytes: Buffer.byteLength(result.bodyText, 'utf8'),
    usage: result.usage,
    modelUsed: result.modelUsed,
    upstreamId: result.upstreamId,
    errorCode: result.errorCode,
    errorMsg: result.errorMsg,
    retryAfterSeconds: result.retryAfterSeconds,
  };
}

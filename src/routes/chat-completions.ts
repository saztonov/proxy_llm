import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { newRequestId, isValidIdempotencyKey, isValidRequestId } from '../utils/ids.js';
import { ActiveRequests, ActiveDedupFullError } from '../dedup/active-requests.js';
import {
  OpenRouterClient,
  type ProxyResult,
  type AttemptObservation,
} from '../upstream/openrouter-client.js';
import { createDeadline } from '../upstream/deadline.js';
import { billingDay } from '../billing/billing-time.js';
import { resolvePayer } from '../billing/payer.js';
import { estimateCost } from '../billing/estimate-cost.js';
import type { BillingRepo, BillingAttemptRecord } from '../storage/billing-repo.js';
import { clientWantedStreaming } from '../upstream/sanitize-payload.js';
import { resolveModel } from '../upstream/resolve-model.js';
import { sanitizeForLog } from '../utils/sanitize.js';
import { sanitizeErrorForLog } from '../utils/sanitize-error.js';
import type { RequestsRepo, RequestRecord } from '../storage/requests-repo.js';
import type { AlertEngine } from '../alerts/rules.js';
import type { ActiveSource, ActiveRequestSnapshot } from '../watchdog/ticker.js';
import { makeBearerAuthHook } from '../auth/bearer.js';
import type { ClientRegistry, ClientConfig } from '../clients/registry.js';
import type { FairnessManager } from '../concurrency/fairness.js';

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
  registry: ClientRegistry;
  fairness: FairnessManager;
  active: ActiveRequests;
  client: OpenRouterClient;
  repo: RequestsRepo;
  billing: BillingRepo;
  alerts: AlertEngine;
  activeMetrics: ActiveMetrics;
}

/** Реестр живых запросов для watchdog'а и для сверки admission-счётчиков (см. concurrency/reconcile.ts). */
export class ActiveMetrics implements ActiveSource {
  private readonly active = new Map<
    string,
    { clientId: string; admitted: boolean; startedAt: number; deadlineAt: number; abort: AbortController }
  >();

  /**
   * `admitted` — прошёл ли этот конкретный request fairness.tryAdmit (а не dedup-join,
   * который делит промис с уже admitted-запросом и слот не занимает). Различие важно для
   * countAdmittedByClient()/countAdmittedTotal() — join-запросы не должны туда попадать.
   */
  register(requestId: string, clientId: string, admitted: boolean, deadlineAt: number, abort: AbortController): void {
    this.active.set(requestId, { clientId, admitted, startedAt: Date.now(), deadlineAt, abort });
  }

  unregister(requestId: string): void {
    this.active.delete(requestId);
  }

  size(): number {
    return this.active.size;
  }

  snapshot(): ActiveRequestSnapshot[] {
    return [...this.active.entries()].map(([requestId, v]) => ({
      requestId,
      startedAt: v.startedAt,
      deadlineAt: v.deadlineAt,
    }));
  }

  abort(requestId: string): void {
    this.active.get(requestId)?.abort.abort();
  }

  /** Живые admitted-запросы (реально занимают fairness-слот) по clientId — эталон для reconcile(). */
  countAdmittedByClient(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const v of this.active.values()) {
      if (!v.admitted) continue;
      counts.set(v.clientId, (counts.get(v.clientId) ?? 0) + 1);
    }
    return counts;
  }

  /** Суммарно admitted-запросов (эталон для глобального счётчика fairness). */
  countAdmittedTotal(): number {
    let n = 0;
    for (const v of this.active.values()) if (v.admitted) n++;
    return n;
  }
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
          onAttempt: makeAttemptSink(deps, ctx, modelResolution.model, candidateExecutionId),
          ...(ctx.client.openrouterApiKey ? { apiKey: ctx.client.openrouterApiKey } : {}),
        }),
      ),
    ) as Promise<ProxyResult>;

  let result: ProxyResult;
  let executionId = candidateExecutionId;
  let joined = false;
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
    persistRecord(deps, ctx, {
      classification: 'upstream_error',
      statusCode: 500,
      bodyText: '',
      attemptCount: 0,
      fallbackUsed: null,
      headers: {},
    } as unknown as ProxyResult, requestBytes, clientIp, {
      executionId,
      joined,
      modelRequested: modelResolution.model,
    });
    reply.code(500).send({ error: { code: 'internal', message: 'internal proxy error' } });
    return;
  } finally {
    deps.activeMetrics.unregister(ctx.requestId);
  }

  persistRecord(deps, ctx, result, requestBytes, clientIp, {
    executionId,
    joined,
    modelRequested: modelResolution.model,
  });

  for (const [k, v] of Object.entries(result.headers)) {
    if (v !== undefined) reply.header(k, v);
  }
  reply.code(result.statusCode);
  reply.send(result.bodyText);
}

interface BillingLink {
  executionId: string;
  joined: boolean;
  modelRequested: string;
}

/**
 * Sink наблюдений за попытками: превращает AttemptObservation в строку ledger'а.
 *
 * Живёт в роуте, а не в OpenRouterClient, чтобы клиент оставался storage-agnostic.
 * Исключения гасит вызывающий (OpenRouterClient.emitAttempt) — учёт не должен ломать прокси.
 */
function makeAttemptSink(
  deps: ChatRoutesDeps,
  ctx: NonNullable<FastifyRequest['proxyContext']>,
  modelRequested: string,
  executionId: string,
): (obs: AttemptObservation) => void {
  const payer = resolvePayer(ctx.client, deps.config.OPENROUTER_API_KEY);
  return (obs) => {
    const modelId = obs.modelUsed ?? modelRequested;
    // Цена, наблюдавшаяся на момент попытки, — не текущая: иначе вчерашний запрос
    // пересчитывался бы по сегодняшнему прайсу.
    const priceVersion = deps.billing.priceVersionAt(modelId, obs.tsStarted);
    const est = estimateCost(priceVersion, obs.usage, modelId);
    const record: BillingAttemptRecord = {
      execution_id: executionId,
      attempt_no: obs.attemptNo,
      request_id: ctx.requestId,
      client_id: ctx.clientId,
      payer_scope: payer.scope,
      api_key_fp: payer.fingerprint,
      ts_started: obs.tsStarted,
      ts_completed: obs.tsCompleted,
      billing_day: billingDay(obs.tsStarted, deps.config.BILLING_TIMEZONE),
      http_status: obs.httpStatus,
      classification: obs.classification,
      model_requested: modelRequested,
      model_used: obs.modelUsed ?? null,
      upstream_id: obs.upstreamId ?? null,
      prompt_tokens: obs.usage?.promptTokens ?? null,
      completion_tokens: obs.usage?.completionTokens ?? null,
      total_tokens: obs.usage?.totalTokens ?? null,
      cached_tokens: obs.usage?.cachedTokens ?? null,
      cache_write_tokens: obs.usage?.cacheWriteTokens ?? null,
      reasoning_tokens: obs.usage?.reasoningTokens ?? null,
      cost_usd: obs.usage?.costUsd ?? null,
      upstream_inference_cost_usd: obs.usage?.upstreamInferenceCostUsd ?? null,
      is_byok: obs.usage?.isByok === undefined ? null : obs.usage.isByok ? 1 : 0,
      usage_source: obs.usageSource,
      // Диагностика: в денежные итоги не входит, показывается отдельно с пометкой «≈».
      cost_est_usd: est.usd,
      est_quality: est.quality,
      est_price_version: priceVersion?.id ?? null,
      usage_json: obs.usage?.raw ?? null,
    };
    deps.billing.insertAttempt(record);
  };
}

function persistRecord(
  deps: ChatRoutesDeps,
  ctx: NonNullable<FastifyRequest['proxyContext']>,
  result: ProxyResult,
  requestBytes: number,
  clientIp: string,
  billing: BillingLink,
): void {
  const tsCompleted = Date.now();
  const record: RequestRecord = {
    request_id: ctx.requestId,
    idempotency_key: ctx.idempotencyKey,
    upstream_id: result.upstreamId ?? null,
    ts_received: ctx.tsReceived,
    ts_completed: tsCompleted,
    model_used: result.modelUsed ?? null,
    fallback_used: result.fallbackUsed,
    status: mapStatus(result.classification),
    http_status: result.statusCode,
    latency_ms: tsCompleted - ctx.tsReceived,
    request_bytes: requestBytes,
    response_bytes: Buffer.byteLength(result.bodyText, 'utf8'),
    // Токены последней попытки — legacy-поля для существующих оперативных агрегатов.
    // Денежный и токенный учёт идёт по billing_attempts, где есть все попытки.
    prompt_tokens: result.usage?.promptTokens ?? null,
    completion_tokens: result.usage?.completionTokens ?? null,
    total_tokens: result.usage?.totalTokens ?? null,
    attempt_count: result.attemptCount,
    retry_after_seconds: result.retryAfterSeconds ?? null,
    error_code: result.errorCode ?? null,
    error_msg: result.errorMsg ? sanitizeForLog(result.errorMsg, 500) : null,
    client_ip: clientIp,
    source: ctx.client.source,
    client_id: ctx.clientId,
    billing_execution_id: billing.executionId,
    dedup_join: billing.joined ? 1 : 0,
    model_requested: billing.modelRequested,
  };

  try {
    deps.repo.insert(record);
  } catch (err) {
    deps.logger.error({ err: sanitizeErrorForLog(err) }, 'failed to persist request record');
  }

  deps.alerts
    .onEvent({
      type: 'request_completed',
      status: record.status,
      httpStatus: record.http_status,
      latencyMs: record.latency_ms,
      errorCode: record.error_code,
      clientId: record.client_id,
    })
    .catch((err: unknown) =>
      deps.logger.warn({ err: sanitizeErrorForLog(err) }, 'alert onEvent failed'),
    );
}

function mapStatus(classification: ProxyResult['classification']): RequestRecord['status'] {
  switch (classification) {
    case 'success':
      return 'success';
    case 'body_level_error':
      return 'body_level_error';
    case 'malformed_success':
      return 'malformed_success';
    case 'upstream_response_too_large':
      return 'upstream_response_too_large';
    case 'network_error':
      return 'timeout';
    case 'upstream_error':
    default:
      return 'upstream_error';
  }
}

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import PQueue from 'p-queue';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { newRequestId, isValidIdempotencyKey, isValidRequestId } from '../utils/ids.js';
import { ActiveRequests, ActiveDedupFullError } from '../dedup/active-requests.js';
import { OpenRouterClient, type ProxyResult } from '../upstream/openrouter-client.js';
import { createDeadline } from '../upstream/deadline.js';
import { clientWantedStreaming } from '../upstream/sanitize-payload.js';
import { sanitizeForLog } from '../utils/sanitize.js';
import { sanitizeErrorForLog } from '../utils/sanitize-error.js';
import type { RequestsRepo, RequestRecord } from '../storage/requests-repo.js';
import type { AlertEngine } from '../alerts/rules.js';
import type { ActiveSource, ActiveRequestSnapshot } from '../watchdog/ticker.js';
import { makeBearerAuthHook } from '../auth/bearer.js';

declare module 'fastify' {
  interface FastifyRequest {
    proxyContext?: {
      requestId: string;
      idempotencyKey: string | null;
      tsReceived: number;
      admitted?: boolean;
    };
  }
}

export interface ChatRoutesDeps {
  config: Config;
  logger: Logger;
  active: ActiveRequests;
  client: OpenRouterClient;
  queue: PQueue;
  repo: RequestsRepo;
  alerts: AlertEngine;
  activeMetrics: ActiveMetrics;
}

/** Реестр живых запросов для watchdog'а. */
export class ActiveMetrics implements ActiveSource {
  private readonly active = new Map<
    string,
    { startedAt: number; deadlineAt: number; abort: AbortController }
  >();

  register(requestId: string, deadlineAt: number, abort: AbortController): void {
    this.active.set(requestId, { startedAt: Date.now(), deadlineAt, abort });
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
}

export async function registerChatRoutes(
  app: FastifyInstance,
  deps: ChatRoutesDeps,
): Promise<void> {
  const bearerAuth = makeBearerAuthHook(deps.config.PROXY_INBOUND_TOKEN);

  const CHAT_PATHS = new Set(['/api/v1/chat/completions', '/v1/chat/completions']);

  /**
   * Атомарный счётчик "запросов, прошедших admission, но ещё не завершившихся".
   * Инкрементируется в onRequest (после успешной валидации), декрементируется в onResponse.
   * Это закрывает race между onRequest hook и queue.add (которое внутри handler).
   */
  let inFlight = 0;

  // Admission control: ДО парсинга body, на onRequest hook.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method !== 'POST') return;
    const path = req.url.split('?')[0];
    if (!path || !CHAT_PATHS.has(path)) return;

    // Bearer проверяем здесь же — отказ до чтения body.
    await bearerAuth(req, reply);
    if (reply.sent) return;

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
      tsReceived: Date.now(),
    };

    // Если ключ уже активен — пропускаем (это dedup), счётчик не трогаем.
    if (idempotencyKey && deps.active.has(idempotencyKey)) return;

    if (
      inFlight >= deps.config.QUEUE_MAX_PENDING ||
      deps.active.size() >= deps.config.MAX_ACTIVE_DEDUP_KEYS
    ) {
      reply.header('Retry-After', '10');
      reply.code(503).send({
        error: { code: 'queue_full', message: 'proxy queue is full, retry later' },
      });
      return;
    }

    inFlight++;
    req.proxyContext.admitted = true;
  });

  app.addHook('onResponse', async (req, _reply) => {
    if (req.proxyContext?.admitted) {
      inFlight = Math.max(0, inFlight - 1);
    }
  });

  app.post(
    '/api/v1/chat/completions',
    {
      bodyLimit: deps.config.BODY_LIMIT_BYTES,
    },
    async (req, reply) => handleChat(req, reply, deps),
  );

  // Алиас для legacy-клиентов
  app.post(
    '/v1/chat/completions',
    {
      bodyLimit: deps.config.BODY_LIMIT_BYTES,
    },
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

  const requestBytes = Buffer.byteLength(JSON.stringify(incoming), 'utf8');
  const clientIp = req.ip;

  const deadline = createDeadline(
    ctx.tsReceived,
    deps.config.REQUEST_DEADLINE_MS,
    deps.config.MIN_REMAINING_MS,
  );
  const abort = new AbortController();
  deps.activeMetrics.register(ctx.requestId, deadline.deadlineAt, abort);

  const factory = async (): Promise<ProxyResult> =>
    deps.queue.add(() => deps.client.execute({
      incoming,
      requestId: ctx.requestId,
      deadline,
    })) as Promise<ProxyResult>;

  let result: ProxyResult;
  try {
    if (ctx.idempotencyKey) {
      result = await deps.active.registerOrJoin(ctx.idempotencyKey, factory);
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
    persistRecord(deps, ctx.requestId, ctx.idempotencyKey, ctx.tsReceived, {
      classification: 'upstream_error',
      statusCode: 500,
      bodyText: '',
      attemptCount: 0,
      fallbackUsed: null,
      headers: {},
    } as unknown as ProxyResult, requestBytes, clientIp);
    reply.code(500).send({ error: { code: 'internal', message: 'internal proxy error' } });
    return;
  } finally {
    deps.activeMetrics.unregister(ctx.requestId);
  }

  persistRecord(deps, ctx.requestId, ctx.idempotencyKey, ctx.tsReceived, result, requestBytes, clientIp);

  for (const [k, v] of Object.entries(result.headers)) {
    if (v !== undefined) reply.header(k, v);
  }
  reply.code(result.statusCode);
  reply.send(result.bodyText);
}

function persistRecord(
  deps: ChatRoutesDeps,
  requestId: string,
  idempotencyKey: string | null,
  tsReceived: number,
  result: ProxyResult,
  requestBytes: number,
  clientIp: string,
): void {
  const tsCompleted = Date.now();
  const record: RequestRecord = {
    request_id: requestId,
    idempotency_key: idempotencyKey,
    upstream_id: result.upstreamId ?? null,
    ts_received: tsReceived,
    ts_completed: tsCompleted,
    model_used: result.modelUsed ?? null,
    fallback_used: result.fallbackUsed,
    status: mapStatus(result.classification),
    http_status: result.statusCode,
    latency_ms: tsCompleted - tsReceived,
    request_bytes: requestBytes,
    response_bytes: Buffer.byteLength(result.bodyText, 'utf8'),
    prompt_tokens: result.usage?.prompt_tokens ?? null,
    completion_tokens: result.usage?.completion_tokens ?? null,
    total_tokens: result.usage?.total_tokens ?? null,
    attempt_count: result.attemptCount,
    retry_after_seconds: result.retryAfterSeconds ?? null,
    error_code: result.errorCode ?? null,
    error_msg: result.errorMsg ? sanitizeForLog(result.errorMsg, 500) : null,
    client_ip: clientIp,
    source: 'passdesk',
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

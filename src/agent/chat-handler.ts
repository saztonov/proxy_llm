import type { FastifyReply, FastifyRequest } from 'fastify';
import { newRequestId } from '../utils/ids.js';
import { createDeadline } from '../upstream/deadline.js';
import { buildAgentPayload } from '../upstream/agent-payload.js';
import { safeParseJson } from '../upstream/read-body-with-limit.js';
import type { ProxyResult } from '../upstream/types.js';
import type { AgentCall, StreamOutcome } from '../upstream/openai-compatible-client.js';
import { makeBillingSink } from '../journal/billing-sink.js';
import { recordRequest, type JournalEntry, type JournalOutcome } from '../journal/record-request.js';
import type { Attribution } from '../journal/attribution.js';
import { sanitizeErrorForLog } from '../utils/sanitize-error.js';
import { sanitizeForLog } from '../utils/sanitize.js';
import { openaiErrorBody, sendOpenAIError } from './errors.js';
import { ClientClosedError, ReplyStreamSink } from './reply-stream-sink.js';
import type { ProviderLimiter } from './limiters.js';
import { releaseAgentAdmission, type AgentDeps } from './deps.js';

export interface AgentHandlerDeps extends AgentDeps {
  providerLimiter: ProviderLimiter;
}

export async function handleAgentChat(req: FastifyRequest, reply: FastifyReply, deps: AgentHandlerDeps): Promise<void> {
  const ctx = req.agentContext;
  const target = ctx?.principal.target;
  if (!ctx || !target) {
    sendOpenAIError(reply, 500, 'internal_error', 'Missing request context.');
    return;
  }
  const { principal } = ctx;
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendOpenAIError(reply, 400, 'invalid_request', 'Request body must be a JSON object.');
    return;
  }
  const incoming = body as Record<string, unknown>;
  if (!Array.isArray(incoming.messages) || incoming.messages.length === 0) {
    sendOpenAIError(reply, 400, 'invalid_request', "'messages' must be a non-empty array.", 'messages');
    return;
  }

  const cfg = deps.config;
  const provider = target.provider;
  const { payload, stream, modelAsked } = buildAgentPayload(incoming, { model: target.model, usageMode: provider.usageMode });
  const deadline = createDeadline(ctx.tsReceived, cfg.AGENT_REQUEST_DEADLINE_MS, cfg.AGENT_MIN_REMAINING_MS);
  const abort = new AbortController();
  deps.activeMetrics.register(ctx.requestId, principal.slotKey, ctx.admitted, deadline.deadlineAt, abort);
  const sink = new ReplyStreamSink(reply);
  sink.onClose(() => abort.abort(new ClientClosedError()));

  const executionId = newRequestId();
  const attribution: Attribution = {
    contour: 'agent',
    tokenId: principal.tokenId,
    departmentId: principal.departmentId,
    employeeId: principal.employeeId,
    providerId: provider.id,
  };
  const onAttempt = makeBillingSink(
    { billing: deps.billing, timezone: cfg.BILLING_TIMEZONE },
    {
      requestId: ctx.requestId,
      clientId: principal.clientIdForJournal,
      payer: provider.payer,
      modelRequested: target.model,
      executionId,
      attribution,
      pricing: provider.kind === 'openrouter' ? 'openrouter' : 'none',
    },
  );
  const entry: JournalEntry = {
    requestId: ctx.requestId,
    idempotencyKey: null,
    tsReceived: ctx.tsReceived,
    clientId: principal.clientIdForJournal,
    source: 'agent',
    clientIp: req.ip,
    attribution,
    executionId,
    joined: false,
    modelRequested: modelAsked,
    requestBytes: Number(req.headers['content-length']) || 0,
  };
  const journal = (o: JournalOutcome): void =>
    recordRequest(deps, entry, o, { longRequestThresholdMs: cfg.AGENT_ALERT_LONG_REQUEST_MS, upstreamLabel: provider.name });

  // Очередь владельца → общая очередь агентов → лимит провайдера. Если клиент ушёл, пока
  // запрос ждал в очереди, к провайдеру не идём вовсе: платить не за что.
  const queued = <T>(fn: () => Promise<T>): Promise<T> =>
    deps.fairness.queueFor(principal.slotKey).add(() =>
      deps.fairness.globalQueue.add(() =>
        deps.providerLimiter.run(provider.id, provider.maxConcurrency, async () => {
          if (abort.signal.aborted) throw abort.signal.reason instanceof Error ? abort.signal.reason : new ClientClosedError();
          return fn();
        }),
      ),
    ) as Promise<T>;

  const call: AgentCall = { payload, requestId: ctx.requestId, deadline, provider, signal: abort.signal, onAttempt };
  try {
    if (!stream) {
      const result = await queued(() => deps.client.executeNonStreaming(call));
      journal(outcomeOfResult(result, sink.clientClosed()));
      sendResult(reply, result, provider.apiKey, provider.name);
      return;
    }
    const exec = await queued(() => deps.client.executeStreaming({ ...call, sink }));
    if (exec.committed) {
      journal(outcomeOfStream(exec.outcome));
      return;
    }
    journal(outcomeOfResult(exec.result, sink.clientClosed()));
    sendResult(reply, exec.result, provider.apiKey, provider.name);
  } catch (err) {
    if (err instanceof ClientClosedError || sink.clientClosed()) {
      journal({
        statusCode: 499, classification: 'client_aborted', attemptCount: 0, fallbackUsed: null, responseBytes: 0,
        errorCode: 'client_closed', errorMsg: 'client closed the connection before the request started',
      });
      return;
    }
    deps.logger.error({ err: sanitizeErrorForLog(err), requestId: ctx.requestId }, 'agent handler error');
    journal({
      statusCode: 500, classification: 'upstream_error', attemptCount: 0, fallbackUsed: null, responseBytes: 0,
      errorCode: 'internal', errorMsg: sanitizeErrorForLog(err).message,
    });
    if (!sink.committed && !reply.sent) sendOpenAIError(reply, 500, 'internal_error', 'Internal proxy error.');
    else sink.end();
  } finally {
    deps.activeMetrics.unregister(ctx.requestId);
    releaseAgentAdmission(req, deps.fairness);
  }
}

function outcomeOfResult(result: ProxyResult, clientClosed: boolean): JournalOutcome {
  return {
    statusCode: result.statusCode,
    classification: clientClosed ? 'client_aborted' : result.classification,
    attemptCount: result.attemptCount,
    fallbackUsed: null,
    responseBytes: Buffer.byteLength(result.bodyText, 'utf8'),
    usage: result.usage,
    modelUsed: result.modelUsed,
    upstreamId: result.upstreamId,
    errorCode: result.errorCode,
    errorMsg: result.errorMsg,
    retryAfterSeconds: result.retryAfterSeconds,
  };
}

function outcomeOfStream(o: StreamOutcome): JournalOutcome {
  return {
    statusCode: 200,
    classification: o.classification,
    attemptCount: o.attemptCount,
    fallbackUsed: null,
    responseBytes: o.responseBytes,
    usage: o.usage,
    modelUsed: o.modelUsed,
    upstreamId: o.upstreamId,
    errorCode: o.errorCode,
    errorMsg: o.errorMsg,
  };
}

/**
 * Ответ клиенту. Отказ провайдера в авторизации или оплате — проблема аккаунта прокси, а не
 * ключа сотрудника: отдаём 502 с понятным текстом (оригинал — в журнале и в алерте). Тело
 * ошибки не в формате OpenAI (HTML шлюза и т.п.) оборачиваем; ключ провайдера вырезаем на
 * случай, если провайдер эхом вернул его в тексте ошибки.
 */
function sendResult(reply: FastifyReply, result: ProxyResult, providerKey: string | null, providerName: string): void {
  if (reply.sent || reply.raw.destroyed) return;
  let status = result.statusCode;
  let body = result.bodyText;
  const headers = { ...result.headers };
  if (status === 401 || status === 403 || status === 402) {
    const code = status === 402 ? 'upstream_payment_required' : 'upstream_auth_failed';
    const message = status === 402
      ? `The account of provider "${providerName}" has run out of credits. Contact the administrator.`
      : `The proxy's credentials for provider "${providerName}" were rejected. Contact the administrator.`;
    status = 502;
    body = openaiErrorBody(code, message);
    headers['content-type'] = 'application/json; charset=utf-8';
  } else if (status >= 400) {
    const parsed = safeParseJson(body) as { error?: unknown } | null;
    if (!parsed || typeof parsed !== 'object' || !parsed.error) {
      body = openaiErrorBody('upstream_error', `The provider returned HTTP ${status}: ${sanitizeForLog(body, 300)}`);
      headers['content-type'] = 'application/json; charset=utf-8';
    }
  }
  if (providerKey && body.includes(providerKey)) body = body.split(providerKey).join('[REDACTED]');
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) reply.header(k, v);
  reply.header('cache-control', 'no-store');
  reply.code(status).send(body);
}

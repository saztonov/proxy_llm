import { request as undiciRequest, errors as undiciErrors, type Dispatcher } from 'undici';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { Deadline } from './deadline.js';
import { classifyHttp, computeBackoffMs, isRetryableBodyCode, type Classification } from './retry.js';
import { readBodyWithLimit, safeParseJson, UpstreamResponseTooLargeError } from './read-body-with-limit.js';
import { agentResponseHeaders } from './filter-response-headers.js';
import { normalizeUsage, hasCost, type NormalizedUsage } from './usage.js';
import { SseParser, interpretChatChunk, type SseEvent } from './sse-parser.js';
import {
  runChatAttempts, emitAttempt, shouldRetry, retryWaitMs, buildResultFromResponse,
  buildResultFromError, makeDeadlineExceeded, sleep,
  type AttemptPolicy, type AttemptLoopOptions, type UpstreamHeaders,
} from './chat-attempt-loop.js';
import type { AttemptObservation, ProxyResult } from './types.js';
import type { AgentProvider, ProviderKind } from '../clients/agent-registry.js';
import { openaiErrorBody, sseErrorEvent } from '../agent/errors.js';
import { ClientClosedError, type StreamSink } from '../agent/reply-stream-sink.js';
import { sanitizeErrorForLog } from '../utils/sanitize-error.js';

export interface AgentStreamPolicy extends AttemptPolicy {
  headersTimeoutMs: number;
  firstEventTimeoutMs: number;
  idleTimeoutMs: number;
  streamLimitBytes: number;
}

export interface AgentCall {
  payload: Record<string, unknown>;
  requestId: string;
  deadline: Deadline;
  provider: AgentProvider;
  /** Внешняя отмена: обрыв клиента (reason — ClientClosedError), watchdog, остановка сервиса. */
  signal: AbortSignal;
  onAttempt?: (obs: AttemptObservation) => void;
}

export type StreamClassification =
  | 'success'
  | 'stream_upstream_error'
  | 'stream_incomplete'
  | 'client_aborted'
  | 'network_error'
  | 'upstream_response_too_large';

export interface StreamOutcome {
  classification: StreamClassification;
  attemptCount: number;
  responseBytes: number;
  usage?: NormalizedUsage;
  modelUsed?: string;
  upstreamId?: string;
  errorCode?: string;
  errorMsg?: string;
}

/** committed=false — клиенту не ушло ни байта, ответ отдаётся обычным JSON. */
export type StreamExecution =
  | { committed: false; result: ProxyResult }
  | { committed: true; outcome: StreamOutcome };

type StreamStep =
  | { kind: 'done'; exec: StreamExecution }
  | { kind: 'failed'; result: ProxyResult; retry: boolean; waitMs: number };

/** Причина abort, выставленная самим стримом, — чтобы отличить её от внешней отмены. */
class StreamTimeout extends Error {
  override readonly name = 'StreamTimeout';
  constructor(readonly code: 'first_event_timeout' | 'deadline_exceeded') {
    super(code);
  }
}

/**
 * Сколько байт можно накопить до первого data-события (keep-alive комментарии и хвосты).
 * Всё это держится в памяти до коммита, поэтому потолок здесь свой и маленький: общий лимит
 * стрима (16 МиБ) на 32 параллельных потока дал бы полгигабайта буферов.
 */
const PRE_COMMIT_LIMIT_BYTES = 1024 * 1024;

const TIMEOUT_MESSAGES: Record<string, string> = {
  first_event_timeout: 'the provider sent no data in time',
  deadline_exceeded: 'request deadline exceeded',
  headers_timeout: 'the provider did not respond in time',
};

function firstHeader(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined;
}

function toBuffer(v: unknown): Buffer {
  return Buffer.isBuffer(v) ? v : Buffer.from(v as Uint8Array);
}

function isHeadersTimeout(err: unknown): boolean {
  return err instanceof undiciErrors.HeadersTimeoutError || (err as { code?: string } | null)?.code === 'UND_ERR_HEADERS_TIMEOUT';
}

function isBodyTimeout(err: unknown): boolean {
  return err instanceof undiciErrors.BodyTimeoutError || (err as { code?: string } | null)?.code === 'UND_ERR_BODY_TIMEOUT';
}

function streamHeaders(requestId: string, upstreamId: string | undefined, kind: ProviderKind): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
    'x-proxy-request-id': requestId,
  };
  if (upstreamId) {
    h['x-upstream-request-id'] = upstreamId;
    if (kind === 'openrouter') h['x-openrouter-request-id'] = upstreamId;
  }
  return h;
}

/** Что удалось узнать из событий стрима: id, модель, usage (последний чанк), ошибка, [DONE]. */
class StreamState {
  usage: Record<string, unknown> | undefined;
  modelUsed: string | undefined;
  upstreamId: string | undefined;
  error: { code: string; message: string } | undefined;
  sawDone = false;

  apply(events: readonly SseEvent[]): void {
    for (const ev of events) {
      const m = interpretChatChunk(ev);
      if (m.kind === 'done') this.sawDone = true;
      else if (m.kind === 'error') this.error ??= { code: m.code ?? 'upstream_error', message: m.message };
      else if (m.kind === 'chunk') {
        if (m.id) this.upstreamId ??= m.id;
        if (m.model) this.modelUsed ??= m.model;
        // Итоговый usage приходит отдельным чанком с пустым choices ПОСЛЕ finish_reason.
        if (m.usage) this.usage = m.usage;
      }
    }
  }
}

/**
 * Клиент OpenAI-совместимых провайдеров для агентского контура.
 * Non-stream — общий цикл попыток; stream — проксирование SSE как есть с параллельным
 * разбором событий. Ретрай стрима возможен только до первого байта, ушедшего клиенту.
 */
export class OpenAICompatibleClient {
  readonly policy: AgentStreamPolicy;
  private readonly referer: string;
  private readonly title: string;

  constructor(
    config: Config,
    private readonly logger: Logger,
    private readonly dispatcher?: Dispatcher,
  ) {
    this.policy = {
      maxAttempts: config.AGENT_UPSTREAM_MAX_ATTEMPTS,
      attemptTimeoutMs: config.AGENT_UPSTREAM_ATTEMPT_TIMEOUT_MS,
      minRemainingMs: config.AGENT_MIN_REMAINING_MS,
      responseBodyLimitBytes: config.AGENT_UPSTREAM_RESPONSE_BODY_LIMIT_BYTES,
      headersTimeoutMs: config.AGENT_UPSTREAM_HEADERS_TIMEOUT_MS,
      firstEventTimeoutMs: config.AGENT_STREAM_FIRST_EVENT_TIMEOUT_MS,
      idleTimeoutMs: config.AGENT_STREAM_IDLE_TIMEOUT_MS,
      streamLimitBytes: config.AGENT_STREAM_RESPONSE_LIMIT_BYTES,
    };
    this.referer = config.OPENROUTER_HTTP_REFERER;
    this.title = config.OPENROUTER_X_TITLE;
  }

  /** Заголовки собираются с нуля: ничего из запроса агента к провайдеру не уходит. */
  headers(p: AgentProvider, requestId: string, stream: boolean): Record<string, string> {
    const h: Record<string, string> = { ...p.extraHeaders, 'Content-Type': 'application/json', 'X-Request-Id': requestId };
    if (p.apiKey) h['Authorization'] = `Bearer ${p.apiKey}`;
    if (stream) h['Accept'] = 'text/event-stream';
    if (p.kind === 'openrouter') {
      if (this.referer) h['HTTP-Referer'] = this.referer;
      if (this.title) {
        h['X-OpenRouter-Title'] = this.title;
        h['X-Title'] = this.title;
      }
    }
    return h;
  }

  private loopOptions(call: AgentCall, stream: boolean): AttemptLoopOptions {
    return {
      endpoint: `${call.provider.baseUrl}/chat/completions`,
      headers: this.headers(call.provider, call.requestId, stream),
      bodyJson: JSON.stringify(call.payload),
      requestId: call.requestId,
      deadline: call.deadline,
      policy: this.policy,
      signal: call.signal,
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      ...(call.onAttempt ? { onAttempt: call.onAttempt } : {}),
      fallbackUsed: () => null,
      proxyErrorBody: openaiErrorBody,
      filterHeaders: (u, rid, uid) => agentResponseHeaders(u, rid, uid, call.provider.kind),
      logger: this.logger,
    };
  }

  executeNonStreaming(call: AgentCall): Promise<ProxyResult> {
    return runChatAttempts(this.loopOptions(call, false));
  }

  async executeStreaming(call: AgentCall & { sink: StreamSink }): Promise<StreamExecution> {
    const opts = this.loopOptions(call, true);
    let lastResult: ProxyResult | null = null;
    for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt++) {
      if (!call.deadline.hasTimeFor(0)) return { committed: false, result: makeDeadlineExceeded(opts, attempt - 1) };
      const step = await this.streamAttempt(call, opts, attempt);
      if (step.kind === 'done') return step.exec;
      lastResult = step.result;
      if (!step.retry || !call.deadline.hasTimeFor(step.waitMs)) return { committed: false, result: step.result };
      await sleep(step.waitMs);
    }
    return { committed: false, result: lastResult ?? makeDeadlineExceeded(opts, this.policy.maxAttempts) };
  }

  private proxyError(opts: AttemptLoopOptions, status: number, code: string, message: string, attempt: number,
    classification: ProxyResult['classification'] = 'upstream_error'): ProxyResult {
    return {
      statusCode: status,
      headers: opts.filterHeaders({}, opts.requestId, null),
      bodyText: openaiErrorBody(code, message),
      classification,
      fallbackUsed: null,
      attemptCount: attempt,
      errorCode: code,
      errorMsg: message,
    };
  }

  /** Сбой до коммита: заголовков клиенту ещё не отправляли, решаем про ретрай. */
  private preCommitFailure(call: AgentCall, opts: AttemptLoopOptions, err: unknown, attempt: number,
    ac: AbortController, observe: (o: Omit<AttemptObservation, 'attemptNo' | 'tsStarted' | 'tsCompleted'>) => void): StreamStep {
    const own = ac.signal.aborted && ac.signal.reason instanceof StreamTimeout ? ac.signal.reason.code : null;
    const code = own ?? (isHeadersTimeout(err) ? 'headers_timeout' : null);
    let result: ProxyResult;
    if (code !== null) {
      this.logger.warn({ requestId: call.requestId, attempt, code }, 'agent stream attempt timed out');
      result = this.proxyError(opts, 504, code, TIMEOUT_MESSAGES[code] ?? code, attempt, 'network_error');
    } else {
      result = buildResultFromError(opts, err, attempt);
    }
    observe({ httpStatus: null, classification: result.classification, usageSource: 'missing' });
    const retry =
      result.classification !== 'upstream_response_too_large' &&
      own !== 'deadline_exceeded' &&
      shouldRetry({ kind: 'network_error', retryable: true }, attempt, call.deadline, this.policy, call.signal);
    return { kind: 'failed', result, retry, waitMs: retry ? computeBackoffMs(attempt) : 0 };
  }

  private async nonStreamResponse(call: AgentCall, opts: AttemptLoopOptions, res: Dispatcher.ResponseData,
    headers: UpstreamHeaders, attempt: number, observe: Observe): Promise<StreamStep> {
    const bodyText = await readBodyWithLimit(res.body, this.policy.responseBodyLimitBytes);
    const parsed = safeParseJson(bodyText);
    if (res.statusCode === 200) {
      // Провайдер проигнорировал stream:true. Генерация оплачена — usage учитываем.
      const usage = normalizeUsage((parsed as { usage?: unknown } | null)?.usage);
      observe({ httpStatus: 200, classification: 'malformed_success', ...(usage ? { usage } : {}), usageSource: hasCost(usage) ? 'response' : 'missing' });
      const result = this.proxyError(opts, 502, 'upstream_not_streaming', 'the provider returned a non-streaming response to a streaming request', attempt, 'malformed_success');
      return { kind: 'failed', result, retry: false, waitMs: 0 };
    }
    const classification = classifyHttp(res.statusCode, parsed);
    const result = buildResultFromResponse(opts, res.statusCode, headers, bodyText, parsed, classification, attempt);
    observe({ httpStatus: res.statusCode, classification: classification.kind, usageSource: 'missing' });
    const retry = shouldRetry(classification, attempt, call.deadline, this.policy, call.signal);
    return { kind: 'failed', result, retry, waitMs: retry ? retryWaitMs(classification, headers, attempt) : 0 };
  }

  private async streamAttempt(call: AgentCall & { sink: StreamSink }, opts: AttemptLoopOptions, attempt: number): Promise<StreamStep> {
    const policy = this.policy;
    const ac = new AbortController();
    const signal = AbortSignal.any([ac.signal, call.signal]);
    const deadlineTimer = setTimeout(() => ac.abort(new StreamTimeout('deadline_exceeded')), Math.max(1, call.deadline.remaining()));
    deadlineTimer.unref?.();
    let firstEventTimer: NodeJS.Timeout | undefined;
    const tsStarted = Date.now();
    const observe: Observe = (o) => emitAttempt(opts, { attemptNo: attempt, tsStarted, tsCompleted: Date.now(), ...o });

    let res: Dispatcher.ResponseData;
    try {
      res = await undiciRequest(opts.endpoint, {
        method: 'POST',
        headers: opts.headers,
        body: opts.bodyJson,
        signal,
        headersTimeout: policy.headersTimeoutMs,
        bodyTimeout: policy.idleTimeoutMs,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
    } catch (err) {
      clearTimeout(deadlineTimer);
      return this.preCommitFailure(call, opts, err, attempt, ac, observe);
    }

    try {
      const headers = res.headers as UpstreamHeaders;
      if (res.statusCode !== 200 || !(firstHeader(headers['content-type']) ?? '').includes('text/event-stream')) {
        return await this.nonStreamResponse(call, opts, res, headers, attempt, observe);
      }

      // Ждём первое data-событие: до него клиенту не ушло ни байта, и ретрай ещё возможен.
      // Keep-alive комментарии (': OPENROUTER PROCESSING') событиями не считаются.
      const parser = new SseParser();
      const pending: Buffer[] = [];
      let bytes = 0;
      const iter = (res.body as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      firstEventTimer = setTimeout(() => ac.abort(new StreamTimeout('first_event_timeout')), policy.firstEventTimeoutMs);
      firstEventTimer.unref?.();
      let events: SseEvent[] = [];
      let ended = false;
      while (events.length === 0) {
        const next = await iter.next();
        if (next.done) {
          ended = true;
          break;
        }
        const chunk = toBuffer(next.value);
        bytes += chunk.length;
        if (bytes > PRE_COMMIT_LIMIT_BYTES) throw new UpstreamResponseTooLargeError(PRE_COMMIT_LIMIT_BYTES);
        pending.push(chunk);
        events = parser.push(chunk);
      }
      clearTimeout(firstEventTimer);
      if (ended) events = [...events, ...parser.flush()];

      const first = events[0];
      if (!first) {
        observe({ httpStatus: 200, classification: 'malformed_success', usageSource: 'missing' });
        const c: Classification = { kind: 'malformed_success', reason: 'empty_stream', retryable: true };
        const retry = shouldRetry(c, attempt, call.deadline, policy, call.signal);
        const result = this.proxyError(opts, 502, 'empty_stream', 'the provider closed the stream without any events', attempt, 'malformed_success');
        return { kind: 'failed', result, retry, waitMs: retry ? computeBackoffMs(attempt) : 0 };
      }
      const meaning = interpretChatChunk(first);
      if (meaning.kind === 'error') {
        // Ошибка первым событием (OpenRouter так отдаёт отказ провайдера при HTTP 200).
        const code = meaning.code ?? 'upstream_error';
        const c: Classification = { kind: 'body_level_error', code, message: meaning.message, retryable: isRetryableBodyCode(code) };
        observe({ httpStatus: 200, classification: 'body_level_error', usageSource: 'missing' });
        const result: ProxyResult = {
          statusCode: meaning.httpCode ?? 502,
          headers: opts.filterHeaders({}, opts.requestId, null),
          bodyText: JSON.stringify(meaning.raw),
          classification: 'body_level_error',
          fallbackUsed: null,
          attemptCount: attempt,
          errorCode: code,
          errorMsg: meaning.message,
        };
        const retry = shouldRetry(c, attempt, call.deadline, policy, call.signal);
        return { kind: 'failed', result, retry, waitMs: retry ? computeBackoffMs(attempt) : 0 };
      }

      // COMMIT: 200 и первые байты уходят клиенту, дальше только проксирование.
      const state = new StreamState();
      state.apply(events);
      call.sink.commit(streamHeaders(opts.requestId, state.upstreamId, call.provider.kind));
      const outcome = await this.pump(call, iter, parser, pending, bytes, state, signal, attempt);
      observe({
        httpStatus: 200,
        classification: outcome.classification,
        ...(outcome.modelUsed ? { modelUsed: outcome.modelUsed } : {}),
        ...(outcome.upstreamId ? { upstreamId: outcome.upstreamId } : {}),
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        usageSource: hasCost(outcome.usage) ? 'response' : 'missing',
      });
      return { kind: 'done', exec: { committed: true, outcome } };
    } catch (err) {
      return this.preCommitFailure(call, opts, err, attempt, ac, observe);
    } finally {
      clearTimeout(deadlineTimer);
      if (firstEventTimer) clearTimeout(firstEventTimer);
      if (!res.body.destroyed) res.body.destroy();
    }
  }

  /** Проксирование после коммита. Никогда не бросает: итог — в StreamOutcome. */
  private async pump(call: AgentCall & { sink: StreamSink }, iter: AsyncIterator<unknown>, parser: SseParser,
    pending: Buffer[], startBytes: number, state: StreamState, signal: AbortSignal, attempt: number): Promise<StreamOutcome> {
    const { sink } = call;
    const limit = this.policy.streamLimitBytes;
    let bytes = startBytes;
    let classification: StreamClassification = 'success';
    let errorCode: string | undefined;
    let errorMsg: string | undefined;
    try {
      await sink.write(Buffer.concat(pending), signal);
      for (;;) {
        const next = await iter.next();
        if (next.done) break;
        const chunk = toBuffer(next.value);
        bytes += chunk.length;
        if (bytes > limit) throw new UpstreamResponseTooLargeError(limit);
        await sink.write(chunk, signal);
        state.apply(parser.push(chunk));
      }
      // Читаем до EOF, а не до finish_reason: usage приходит отдельным чанком после него.
      state.apply(parser.flush());
      if (state.error) {
        classification = 'stream_upstream_error';
        errorCode = state.error.code;
        errorMsg = state.error.message;
      } else if (!state.sawDone) {
        classification = 'stream_incomplete';
        errorCode = 'eof_without_done';
        errorMsg = 'the provider closed the stream before [DONE]';
        await this.tryWrite(sink, sseErrorEvent('stream_incomplete', 'The provider closed the stream early; the answer may be incomplete.'));
      }
    } catch (err) {
      if (err instanceof ClientClosedError || sink.clientClosed() || call.signal.reason instanceof ClientClosedError) {
        classification = 'client_aborted';
        errorCode = 'client_closed';
        errorMsg = 'client closed the connection';
      } else {
        const own = signal.reason instanceof StreamTimeout ? signal.reason.code : null;
        let code: string;
        let message: string;
        if (err instanceof UpstreamResponseTooLargeError) {
          classification = 'upstream_response_too_large';
          code = 'upstream_response_too_large';
          message = `the response exceeded ${limit} bytes`;
        } else {
          classification = 'network_error';
          if (own) {
            code = own;
            message = TIMEOUT_MESSAGES[own] ?? own;
          } else if (isBodyTimeout(err)) {
            code = 'stream_idle_timeout';
            message = `the provider sent no data for ${Math.round(this.policy.idleTimeoutMs / 1000)} s`;
          } else if (call.signal.aborted) {
            code = 'aborted';
            message = 'the request was aborted by the proxy (restart or watchdog)';
          } else {
            code = 'network_error';
            message = sanitizeErrorForLog(err).message;
          }
        }
        errorCode = code;
        errorMsg = message;
        this.logger.warn({ requestId: call.requestId, code, err: sanitizeErrorForLog(err) }, 'agent stream interrupted');
        await this.tryWrite(sink, sseErrorEvent(code, message));
      }
    } finally {
      sink.end();
    }
    const usage = state.usage ? normalizeUsage(state.usage) : undefined;
    return {
      classification,
      attemptCount: attempt,
      responseBytes: bytes,
      usage,
      modelUsed: state.modelUsed,
      upstreamId: state.upstreamId,
      errorCode,
      errorMsg,
    };
  }

  private async tryWrite(sink: StreamSink, text: string): Promise<void> {
    if (sink.clientClosed()) return;
    try {
      await sink.write(text);
    } catch {
      // Клиент ушёл — сообщать некому.
    }
  }
}

type Observe = (o: Omit<AttemptObservation, 'attemptNo' | 'tsStarted' | 'tsCompleted'>) => void;

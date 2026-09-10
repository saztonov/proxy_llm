import { request as undiciRequest, errors as undiciErrors, type Dispatcher } from 'undici';
import type { Deadline } from './deadline.js';
import { classifyHttp, computeBackoffMs, type Classification } from './retry.js';
import { parseRetryAfterMs } from './parse-retry-after.js';
import { readBodyWithLimit, safeParseJson, UpstreamResponseTooLargeError } from './read-body-with-limit.js';
import type { FilteredHeaders } from './filter-response-headers.js';
import { normalizeUsage, hasCost } from './usage.js';
import { sanitizeErrorForLog } from '../utils/sanitize-error.js';
import type { Logger } from '../utils/logger.js';
import type { AttemptObservation, ProxyResult } from './types.js';

export interface AttemptPolicy {
  maxAttempts: number;
  attemptTimeoutMs: number;
  minRemainingMs: number;
  responseBodyLimitBytes: number;
}

export type UpstreamHeaders = Record<string, string | string[] | undefined>;
export type HeaderFilter = (upstream: UpstreamHeaders, requestId: string, upstreamId: string | null) => FilteredHeaders;
/** Тело ошибки, которую формирует сам прокси (таймаут, сеть, слишком большой ответ). */
export type ProxyErrorBody = (code: string, message: string) => string;

/** Формат ошибок контура сайтов — не менять: на него завязаны порталы. */
export const siteErrorBody: ProxyErrorBody = (code, message) => JSON.stringify({ error: { code, message } });

export interface AttemptLoopOptions {
  endpoint: string;
  headers: Record<string, string>;
  bodyJson: string;
  requestId: string;
  deadline: Deadline;
  policy: AttemptPolicy;
  /** Внешняя отмена (клиент ушёл, watchdog, остановка сервиса) — доводится до undici. */
  signal?: AbortSignal;
  dispatcher?: Dispatcher;
  onAttempt?: (obs: AttemptObservation) => void;
  fallbackUsed: (modelUsed: string | undefined) => number | null;
  proxyErrorBody: ProxyErrorBody;
  filterHeaders: HeaderFilter;
  logger: Logger;
}

/**
 * Цикл попыток non-streaming chat-запроса — общий для OpenRouter-клиента сайтов и
 * OpenAI-совместимого клиента агентов. Общий бюджет — deadline; каждая попытка ограничена
 * attemptTimeoutMs; перед ретраем проверяется, хватит ли остатка на ожидание.
 */
export async function runChatAttempts(opts: AttemptLoopOptions): Promise<ProxyResult> {
  const { deadline, policy } = opts;
  let lastResult: ProxyResult | null = null;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    if (!deadline.hasTimeFor(0)) return makeDeadlineExceeded(opts, attempt - 1);

    const attemptTimeoutMs = deadline.attemptTimeout(policy.attemptTimeoutMs);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), attemptTimeoutMs).unref();
    // Внешний abort объединяем с per-attempt timeout — оба доводятся до undici.
    const signal = opts.signal ? AbortSignal.any([ac.signal, opts.signal]) : ac.signal;
    const tsStarted = Date.now();

    try {
      const res = await undiciRequest(opts.endpoint, {
        method: 'POST',
        headers: opts.headers,
        body: opts.bodyJson,
        signal,
        ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
      });
      const bodyText = await readBodyWithLimit(res.body, policy.responseBodyLimitBytes);
      const parsed = safeParseJson(bodyText);
      const classification = classifyHttp(res.statusCode, parsed);
      const headers = res.headers as UpstreamHeaders;
      const result = buildResultFromResponse(opts, res.statusCode, headers, bodyText, parsed, classification, attempt);

      emitAttempt(opts, {
        attemptNo: attempt,
        tsStarted,
        tsCompleted: Date.now(),
        httpStatus: res.statusCode,
        classification: classification.kind,
        ...(result.modelUsed ? { modelUsed: result.modelUsed } : {}),
        ...(result.upstreamId ? { upstreamId: result.upstreamId } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        usageSource: hasCost(result.usage) ? 'response' : 'missing',
      });

      if (classification.kind === 'success') return result;
      if (shouldRetry(classification, attempt, deadline, policy, opts.signal)) {
        const waitMs = retryWaitMs(classification, headers, attempt);
        if (!deadline.hasTimeFor(waitMs)) return result;
        await sleep(waitMs);
        lastResult = result;
        continue;
      }
      return result;
    } catch (err) {
      clearTimeout(timer);
      const result = buildResultFromError(opts, err, attempt);
      // Тело не разобрано (обрыв, таймаут, слишком большой ответ) — генерация могла быть
      // оплачена, но cost и generation ID недоступны. Дыра покрытия по построению: пишем её
      // явно, чтобы она была видна в отчётах, а не молча исчезала.
      emitAttempt(opts, {
        attemptNo: attempt,
        tsStarted,
        tsCompleted: Date.now(),
        httpStatus: null,
        classification: result.classification,
        usageSource: 'missing',
      });
      if (result.classification === 'upstream_response_too_large') return result;
      if (shouldRetry({ kind: 'network_error', retryable: true }, attempt, deadline, policy, opts.signal)) {
        const waitMs = computeBackoffMs(attempt);
        if (!deadline.hasTimeFor(waitMs)) return result;
        await sleep(waitMs);
        lastResult = result;
        continue;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  return lastResult ?? makeDeadlineExceeded(opts, policy.maxAttempts);
}

/** Отдаёт наблюдение биллингу. Сбой учёта не должен ломать проксирование — гасим всё. */
export function emitAttempt(
  opts: Pick<AttemptLoopOptions, 'onAttempt' | 'logger' | 'requestId'>,
  obs: AttemptObservation,
): void {
  if (!opts.onAttempt) return;
  try {
    opts.onAttempt(obs);
  } catch (err) {
    opts.logger.warn(
      { err: sanitizeErrorForLog(err), requestId: opts.requestId, attempt: obs.attemptNo },
      'billing attempt sink failed',
    );
  }
}

export function shouldRetry(
  classification: Classification,
  attempt: number,
  deadline: Deadline,
  policy: AttemptPolicy,
  signal?: AbortSignal,
): boolean {
  // Внешняя отмена: клиент ушёл, watchdog или остановка сервиса. Повтор здесь лишь заплатил
  // бы за генерацию, которую некому отдать.
  if (signal?.aborted) return false;
  if (attempt >= policy.maxAttempts) return false;
  if (deadline.remaining() <= policy.minRemainingMs) return false;
  switch (classification.kind) {
    case 'success':
      return false;
    case 'malformed_success':
    case 'body_level_error':
    case 'upstream_error':
      return classification.retryable;
    case 'network_error':
      return true;
    default:
      return false;
  }
}

export function retryWaitMs(classification: Classification, headers: UpstreamHeaders, attempt: number): number {
  if (classification.kind === 'upstream_error' && (classification.httpStatus === 429 || classification.httpStatus === 503)) {
    const fromHeader = parseRetryAfterMs(headers['retry-after']);
    if (fromHeader !== null) return fromHeader;
  }
  return computeBackoffMs(attempt);
}

export function buildResultFromResponse(
  opts: Pick<AttemptLoopOptions, 'filterHeaders' | 'fallbackUsed' | 'requestId'>,
  statusCode: number,
  upstreamHeaders: UpstreamHeaders,
  bodyText: string,
  parsed: unknown,
  classification: Classification,
  attempt: number,
): ProxyResult {
  const parsedObj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  const upstreamId = typeof parsedObj?.id === 'string' ? parsedObj.id : null;
  const modelUsed = typeof parsedObj?.model === 'string' ? parsedObj.model : undefined;
  // Строгая нормализация вместо каста: негодное поле usage становится NULL, но не роняет
  // bind в better-sqlite3 (иначе потерялась бы ВСЯ строка журнала).
  const usage = normalizeUsage(parsedObj?.usage);

  const result: ProxyResult = {
    statusCode,
    headers: opts.filterHeaders(upstreamHeaders, opts.requestId, upstreamId),
    bodyText,
    classification: classification.kind,
    fallbackUsed: opts.fallbackUsed(modelUsed),
    attemptCount: attempt,
  };
  if (usage) result.usage = usage;
  if (modelUsed) result.modelUsed = modelUsed;
  if (upstreamId) result.upstreamId = upstreamId;

  if (classification.kind === 'body_level_error') {
    result.errorCode = classification.code;
    result.errorMsg = classification.message;
  } else if (classification.kind === 'upstream_error') {
    if (classification.code) result.errorCode = classification.code;
    if (classification.message) result.errorMsg = classification.message;
    const retryAfter = parseRetryAfterMs(upstreamHeaders['retry-after']);
    if (retryAfter !== null) result.retryAfterSeconds = Math.round(retryAfter / 1000);
  } else if (classification.kind === 'malformed_success') {
    result.errorCode = classification.reason;
  }
  return result;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof undiciErrors.RequestAbortedError || (err as { name?: string } | null)?.name === 'AbortError';
}

export function buildResultFromError(
  opts: Pick<AttemptLoopOptions, 'filterHeaders' | 'proxyErrorBody' | 'requestId' | 'logger' | 'signal'>,
  err: unknown,
  attempt: number,
): ProxyResult {
  const sanitized = sanitizeErrorForLog(err);
  opts.logger.warn({ err: sanitized, requestId: opts.requestId, attempt }, 'upstream attempt failed');
  const headers = opts.filterHeaders({}, opts.requestId, null);

  if (err instanceof UpstreamResponseTooLargeError) {
    return {
      statusCode: 502,
      headers,
      bodyText: opts.proxyErrorBody('upstream_response_too_large', 'upstream response exceeded limit'),
      classification: 'upstream_response_too_large',
      fallbackUsed: null,
      attemptCount: attempt,
      errorCode: 'upstream_response_too_large',
      errorMsg: sanitized.message,
    };
  }

  // AbortError без внешней отмены = таймаут одной попытки.
  const external = opts.signal?.aborted === true;
  const isAbort = isAbortError(err);
  const code = external ? 'aborted' : isAbort ? 'attempt_timeout' : 'network_error';
  return {
    statusCode: 504,
    headers,
    bodyText: opts.proxyErrorBody(code, sanitized.message),
    classification: 'network_error',
    fallbackUsed: null,
    attemptCount: attempt,
    errorCode: external || isAbort ? code : (sanitized.code ?? 'network_error'),
    errorMsg: sanitized.message,
  };
}

export function makeDeadlineExceeded(
  opts: Pick<AttemptLoopOptions, 'filterHeaders' | 'proxyErrorBody' | 'requestId'>,
  attemptCount: number,
): ProxyResult {
  return {
    statusCode: 504,
    headers: opts.filterHeaders({}, opts.requestId, null),
    bodyText: opts.proxyErrorBody('deadline_exceeded', 'request deadline exceeded'),
    classification: 'upstream_error',
    fallbackUsed: null,
    attemptCount,
    errorCode: 'deadline_exceeded',
    errorMsg: 'request deadline exceeded',
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

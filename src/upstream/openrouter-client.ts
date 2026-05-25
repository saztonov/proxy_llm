import { request as undiciRequest, errors as undiciErrors } from 'undici';
import type { Config } from '../config.js';
import { createDeadline, type Deadline } from './deadline.js';
import {
  classifyHttp,
  computeBackoffMs,
  type Classification,
} from './retry.js';
import { parseRetryAfterMs } from './parse-retry-after.js';
import {
  readBodyWithLimit,
  safeParseJson,
  UpstreamResponseTooLargeError,
} from './read-body-with-limit.js';
import { filterResponseHeaders, type FilteredHeaders } from './filter-response-headers.js';
import { buildUpstreamPayload } from './sanitize-payload.js';
import { sanitizeErrorForLog } from '../utils/sanitize-error.js';
import type { Logger } from '../utils/logger.js';

export interface ProxyResult {
  statusCode: number;
  headers: FilteredHeaders;
  bodyText: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  modelUsed?: string;
  upstreamId?: string;
  classification: Classification['kind'];
  /** best-effort: 1=fallback, 0=primary, null=неоднозначно */
  fallbackUsed: number | null;
  attemptCount: number;
  errorCode?: string;
  errorMsg?: string;
  retryAfterSeconds?: number;
}

export interface ExecuteOptions {
  incoming: Record<string, unknown>;
  requestId: string;
  deadline?: Deadline;
}

export class OpenRouterClient {
  private readonly endpoint: string;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.endpoint = `${config.OPENROUTER_BASE_URL.replace(/\/$/, '')}/api/v1/chat/completions`;
  }

  async execute(opts: ExecuteOptions): Promise<ProxyResult> {
    const deadline =
      opts.deadline ??
      createDeadline(Date.now(), this.config.REQUEST_DEADLINE_MS, this.config.MIN_REMAINING_MS);

    const upstreamPayload = buildUpstreamPayload(opts.incoming, {
      model: this.config.OPENROUTER_MODEL,
      fallbackModels: this.config.OPENROUTER_FALLBACK_MODELS,
    });
    const bodyJson = JSON.stringify(upstreamPayload);

    let lastResult: ProxyResult | null = null;

    for (let attempt = 1; attempt <= this.config.UPSTREAM_MAX_ATTEMPTS; attempt++) {
      if (!deadline.hasTimeFor(0)) {
        return this.makeDeadlineExceeded(opts.requestId, attempt - 1);
      }

      const attemptTimeoutMs = deadline.attemptTimeout(this.config.UPSTREAM_ATTEMPT_TIMEOUT_MS);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), attemptTimeoutMs).unref();

      try {
        const res = await undiciRequest(this.endpoint, {
          method: 'POST',
          headers: this.buildUpstreamHeaders(opts.requestId),
          body: bodyJson,
          signal: ac.signal,
        });

        const bodyText = await readBodyWithLimit(
          res.body,
          this.config.UPSTREAM_RESPONSE_BODY_LIMIT_BYTES,
        );
        const parsed = safeParseJson(bodyText);
        const classification = classifyHttp(res.statusCode, parsed);
        const result = this.buildResultFromResponse(
          res.statusCode,
          res.headers as Record<string, string | string[] | undefined>,
          bodyText,
          parsed,
          classification,
          opts.requestId,
          attempt,
        );

        if (classification.kind === 'success') {
          return result;
        }

        if (this.shouldRetry(classification, attempt, deadline)) {
          const waitMs = this.waitMs(classification, res.headers, attempt);
          if (!deadline.hasTimeFor(waitMs)) {
            return result;
          }
          await sleep(waitMs);
          lastResult = result;
          continue;
        }

        return result;
      } catch (err) {
        clearTimeout(timer);
        const result = this.buildResultFromError(err, opts.requestId, attempt);

        if (result.classification === 'upstream_response_too_large') {
          return result;
        }

        if (this.shouldRetry({ kind: 'network_error', retryable: true }, attempt, deadline)) {
          const waitMs = computeBackoffMs(attempt);
          if (!deadline.hasTimeFor(waitMs)) {
            return result;
          }
          await sleep(waitMs);
          lastResult = result;
          continue;
        }
        return result;
      } finally {
        clearTimeout(timer);
      }
    }

    return lastResult ?? this.makeDeadlineExceeded(opts.requestId, this.config.UPSTREAM_MAX_ATTEMPTS);
  }

  private buildUpstreamHeaders(requestId: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.config.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
    };
    if (this.config.OPENROUTER_HTTP_REFERER) {
      headers['HTTP-Referer'] = this.config.OPENROUTER_HTTP_REFERER;
    }
    if (this.config.OPENROUTER_X_TITLE) {
      headers['X-OpenRouter-Title'] = this.config.OPENROUTER_X_TITLE;
      // Legacy дубль для обратной совместимости со старыми примерами/прокси.
      headers['X-Title'] = this.config.OPENROUTER_X_TITLE;
    }
    return headers;
  }

  private buildResultFromResponse(
    statusCode: number,
    upstreamHeaders: Record<string, string | string[] | undefined>,
    bodyText: string,
    parsed: unknown,
    classification: Classification,
    requestId: string,
    attempt: number,
  ): ProxyResult {
    const parsedObj = (parsed && typeof parsed === 'object') ? (parsed as Record<string, unknown>) : null;
    const upstreamId = typeof parsedObj?.id === 'string' ? parsedObj.id : null;
    const modelUsed = typeof parsedObj?.model === 'string' ? parsedObj.model : undefined;
    const usage = parsedObj?.usage && typeof parsedObj.usage === 'object'
      ? (parsedObj.usage as ProxyResult['usage'])
      : undefined;

    const result: ProxyResult = {
      statusCode,
      headers: filterResponseHeaders(upstreamHeaders, requestId, upstreamId),
      bodyText,
      classification: classification.kind,
      fallbackUsed: this.computeFallbackUsed(modelUsed),
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

  private buildResultFromError(err: unknown, requestId: string, attempt: number): ProxyResult {
    const sanitized = sanitizeErrorForLog(err);
    this.logger.warn({ err: sanitized, requestId, attempt }, 'upstream attempt failed');

    if (err instanceof UpstreamResponseTooLargeError) {
      return {
        statusCode: 502,
        headers: filterResponseHeaders({}, requestId, null),
        bodyText: JSON.stringify({
          error: { code: 'upstream_response_too_large', message: 'upstream response exceeded limit' },
        }),
        classification: 'upstream_response_too_large',
        fallbackUsed: null,
        attemptCount: attempt,
        errorCode: 'upstream_response_too_large',
        errorMsg: sanitized.message,
      };
    }

    // AbortError = таймаут одной попытки
    const isAbort =
      err instanceof undiciErrors.RequestAbortedError ||
      (err as { name?: string })?.name === 'AbortError';

    return {
      statusCode: 504,
      headers: filterResponseHeaders({}, requestId, null),
      bodyText: JSON.stringify({
        error: { code: isAbort ? 'attempt_timeout' : 'network_error', message: sanitized.message },
      }),
      classification: 'network_error',
      fallbackUsed: null,
      attemptCount: attempt,
      errorCode: isAbort ? 'attempt_timeout' : (sanitized.code ?? 'network_error'),
      errorMsg: sanitized.message,
    };
  }

  private computeFallbackUsed(modelUsed: string | undefined): number | null {
    if (!modelUsed) return null;
    if (modelUsed === this.config.OPENROUTER_MODEL) return 0;
    if (this.config.OPENROUTER_FALLBACK_MODELS.includes(modelUsed)) return 1;
    return null;
  }

  private shouldRetry(classification: Classification, attempt: number, deadline: Deadline): boolean {
    if (attempt >= this.config.UPSTREAM_MAX_ATTEMPTS) return false;
    if (deadline.remaining() <= this.config.MIN_REMAINING_MS) return false;
    if (classification.kind === 'success') return false;
    if (classification.kind === 'malformed_success') return false;
    if (classification.kind === 'body_level_error') return classification.retryable;
    if (classification.kind === 'upstream_error') return classification.retryable;
    if (classification.kind === 'network_error') return true;
    return false;
  }

  private waitMs(
    classification: Classification,
    headers: Record<string, string | string[] | undefined>,
    attempt: number,
  ): number {
    if (
      (classification.kind === 'upstream_error' && classification.httpStatus === 429) ||
      (classification.kind === 'upstream_error' && classification.httpStatus === 503)
    ) {
      const fromHeader = parseRetryAfterMs(headers['retry-after']);
      if (fromHeader !== null) return fromHeader;
    }
    return computeBackoffMs(attempt);
  }

  private makeDeadlineExceeded(requestId: string, attemptCount: number): ProxyResult {
    return {
      statusCode: 504,
      headers: filterResponseHeaders({}, requestId, null),
      bodyText: JSON.stringify({
        error: { code: 'deadline_exceeded', message: 'request deadline exceeded' },
      }),
      classification: 'upstream_error',
      fallbackUsed: null,
      attemptCount,
      errorCode: 'deadline_exceeded',
      errorMsg: 'request deadline exceeded',
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

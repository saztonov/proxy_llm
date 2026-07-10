/**
 * Классификация ответов OpenRouter. Источники:
 * 1) HTTP status (terminal vs retryable);
 * 2) body-level error при 2xx (OpenRouter может вернуть 200 с error в JSON);
 * 3) malformed success (нет choices / finish_reason='error' / пустой content).
 */

export type Classification =
  | { kind: 'success' }
  | { kind: 'body_level_error'; code: string; message: string; retryable: boolean }
  | { kind: 'malformed_success'; reason: string; retryable: boolean }
  | { kind: 'upstream_error'; httpStatus: number; retryable: boolean; code?: string; message?: string }
  | { kind: 'network_error'; retryable: true; code?: string; message?: string }
  | { kind: 'upstream_response_too_large' };

/** Body-level error codes, которые имеет смысл повторить. */
const BODY_RETRYABLE_CODES = new Set([
  'provider_unavailable',
  'provider_timeout',
  'timeout',
  'internal_error',
  'service_unavailable',
  'temporarily_unavailable',
  'upstream_error',
  'rate_limit_exceeded',
]);

const HTTP_RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const HTTP_TERMINAL_STATUSES = new Set([400, 401, 402, 403, 404, 405, 409, 422]);

export function classifyHttp(statusCode: number, parsed: unknown): Classification {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null;

  if (statusCode >= 200 && statusCode < 300) {
    if (isObj(parsed) && isObj(parsed.error)) {
      const err = parsed.error;
      const code = String(err.code ?? err.type ?? 'unknown');
      const message = String(err.message ?? '');
      return {
        kind: 'body_level_error',
        code,
        message,
        retryable: BODY_RETRYABLE_CODES.has(code),
      };
    }

    if (!isObj(parsed) || !Array.isArray(parsed.choices) || parsed.choices.length === 0) {
      return { kind: 'malformed_success', reason: 'missing_choices', retryable: true };
    }

    const first = parsed.choices[0] as Record<string, unknown> | undefined;
    if (first && first.finish_reason === 'error') {
      return { kind: 'malformed_success', reason: 'finish_reason_error', retryable: true };
    }

    const message = first && isObj(first.message) ? (first.message as Record<string, unknown>) : null;
    const content = message?.content;
    if (content === '' || content === null || content === undefined) {
      // Пустой content может быть валиден (если есть tool_calls), но для OCR обычно нет.
      // Не ретраим: повтор легитимно пустого ответа лишь потратит попытку.
      if (!message || (!('tool_calls' in message) && !('refusal' in message))) {
        return { kind: 'malformed_success', reason: 'empty_content', retryable: false };
      }
    }

    return { kind: 'success' };
  }

  if (HTTP_RETRYABLE_STATUSES.has(statusCode)) {
    return {
      kind: 'upstream_error',
      httpStatus: statusCode,
      retryable: true,
      ...extractError(parsed),
    };
  }
  if (HTTP_TERMINAL_STATUSES.has(statusCode)) {
    return {
      kind: 'upstream_error',
      httpStatus: statusCode,
      retryable: false,
      ...extractError(parsed),
    };
  }
  return {
    kind: 'upstream_error',
    httpStatus: statusCode,
    retryable: statusCode >= 500,
    ...extractError(parsed),
  };
}

function extractError(parsed: unknown): { code?: string; message?: string } {
  if (typeof parsed === 'object' && parsed !== null) {
    const err = (parsed as Record<string, unknown>).error;
    if (typeof err === 'object' && err !== null) {
      const e = err as Record<string, unknown>;
      const out: { code?: string; message?: string } = {};
      if (typeof e.code === 'string' || typeof e.code === 'number') out.code = String(e.code);
      if (typeof e.message === 'string') out.message = e.message;
      return out;
    }
  }
  return {};
}

/** Network-level ошибка (DNS, ECONNRESET, abort, socket hangup) — всегда retryable. */
export function classifyNetwork(err: unknown): Classification {
  const e = err as { code?: string; message?: string; name?: string };
  return {
    kind: 'network_error',
    retryable: true,
    code: e?.code ?? e?.name,
    message: e?.message,
  };
}

export function computeBackoffMs(attempt: number): number {
  // attempt: 1, 2, 3, ... — backoff удваивается до 10s
  return Math.min(2000 * 2 ** (attempt - 1), 10_000);
}

import type { Config } from '../config.js';
import { createDeadline, type Deadline } from './deadline.js';
import { filterResponseHeaders } from './filter-response-headers.js';
import { buildUpstreamPayload } from './sanitize-payload.js';
import type { ModelResolution } from './resolve-model.js';
import type { Logger } from '../utils/logger.js';
import { runChatAttempts, siteErrorBody, type AttemptPolicy } from './chat-attempt-loop.js';
import type { AttemptObservation, ProxyResult } from './types.js';

export type { AttemptObservation, ProxyResult } from './types.js';

export interface ExecuteOptions {
  incoming: Record<string, unknown>;
  requestId: string;
  deadline?: Deadline;
  /** Эффективная модель (+fallback) для этого запроса; резолвится до вызова. */
  modelResolution: ModelResolution;
  /** Для логирования/атрибуции. */
  clientId?: string;
  /** Внешний abort (watchdog/graceful/обрыв клиента) — доводится до undici-запроса. */
  signal?: AbortSignal;
  /** Per-tenant ключ OpenRouter; иначе глобальный OPENROUTER_API_KEY. */
  apiKey?: string;
  /**
   * Биллинговый sink: вызывается после каждой фактической попытки, до решения о ретрае.
   * Исключения из колбэка гасятся — сбой учёта не должен ломать проксирование.
   */
  onAttempt?: (obs: AttemptObservation) => void;
}

/** Клиент OpenRouter для контура сайтов: payload по политике клиента, без стриминга. */
export class OpenRouterClient {
  private readonly endpoint: string;
  private readonly policy: AttemptPolicy;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.endpoint = `${config.OPENROUTER_BASE_URL.replace(/\/$/, '')}/api/v1/chat/completions`;
    this.policy = {
      maxAttempts: config.UPSTREAM_MAX_ATTEMPTS,
      attemptTimeoutMs: config.UPSTREAM_ATTEMPT_TIMEOUT_MS,
      minRemainingMs: config.MIN_REMAINING_MS,
      responseBodyLimitBytes: config.UPSTREAM_RESPONSE_BODY_LIMIT_BYTES,
    };
  }

  async execute(opts: ExecuteOptions): Promise<ProxyResult> {
    const deadline =
      opts.deadline ??
      createDeadline(Date.now(), this.config.REQUEST_DEADLINE_MS, this.config.MIN_REMAINING_MS);
    const upstreamPayload = buildUpstreamPayload(opts.incoming, opts.modelResolution);

    return runChatAttempts({
      endpoint: this.endpoint,
      headers: this.buildUpstreamHeaders(opts.requestId, opts.apiKey),
      bodyJson: JSON.stringify(upstreamPayload),
      requestId: opts.requestId,
      deadline,
      policy: this.policy,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onAttempt ? { onAttempt: opts.onAttempt } : {}),
      fallbackUsed: (modelUsed) => computeFallbackUsed(modelUsed, opts.modelResolution),
      proxyErrorBody: siteErrorBody,
      filterHeaders: filterResponseHeaders,
      logger: this.logger,
    });
  }

  private buildUpstreamHeaders(requestId: string, apiKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey ?? this.config.OPENROUTER_API_KEY}`,
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
}

function computeFallbackUsed(modelUsed: string | undefined, resolution: ModelResolution): number | null {
  if (!modelUsed) return null;
  if (modelUsed === resolution.model) return 0;
  if (resolution.fallbackModels.includes(modelUsed)) return 1;
  return null;
}

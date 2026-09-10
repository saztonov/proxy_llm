import type { RequestsRepo, RequestRecord } from '../storage/requests-repo.js';
import type { AlertEngine } from '../alerts/rules.js';
import type { Logger } from '../utils/logger.js';
import type { NormalizedUsage } from '../upstream/usage.js';
import type { AttemptClassification } from '../upstream/types.js';
import { sanitizeForLog } from '../utils/sanitize.js';
import { sanitizeErrorForLog } from '../utils/sanitize-error.js';
import { mapStatus } from './status-map.js';
import type { Attribution } from './attribution.js';

export interface JournalEntry {
  requestId: string;
  idempotencyKey: string | null;
  tsReceived: number;
  clientId: string;
  source: string;
  clientIp: string;
  attribution: Attribution;
  executionId: string;
  joined: boolean;
  /** Сайты — эффективная модель; агенты — что прислал клиент (статистика «что просили»). */
  modelRequested: string | null;
  requestBytes: number;
}

export interface JournalOutcome {
  statusCode: number;
  classification: AttemptClassification;
  attemptCount: number;
  fallbackUsed: number | null;
  responseBytes: number;
  usage?: NormalizedUsage;
  modelUsed?: string;
  upstreamId?: string;
  errorCode?: string;
  errorMsg?: string;
  retryAfterSeconds?: number;
}

export interface JournalDeps {
  repo: RequestsRepo;
  alerts: AlertEngine;
  logger: Logger;
}

export interface AlertOptions {
  /** Порог «долгого запроса» контура (стримы агентов длятся минутами). */
  longRequestThresholdMs?: number;
  /** Кто ответил 401/402: 'OpenRouter' или имя провайдера агентского контура. */
  upstreamLabel?: string;
}

/** Строка журнала + событие для алертов. Сбой записи не ломает ответ клиенту. */
export function recordRequest(
  deps: JournalDeps,
  entry: JournalEntry,
  outcome: JournalOutcome,
  alertOpts: AlertOptions = {},
): void {
  const tsCompleted = Date.now();
  const record: RequestRecord = {
    request_id: entry.requestId,
    idempotency_key: entry.idempotencyKey,
    upstream_id: outcome.upstreamId ?? null,
    ts_received: entry.tsReceived,
    ts_completed: tsCompleted,
    model_used: outcome.modelUsed ?? null,
    fallback_used: outcome.fallbackUsed,
    status: mapStatus(outcome.classification),
    http_status: outcome.statusCode,
    latency_ms: tsCompleted - entry.tsReceived,
    request_bytes: entry.requestBytes,
    response_bytes: outcome.responseBytes,
    // Токены последней попытки — legacy-поля для оперативных агрегатов.
    // Денежный и токенный учёт идёт по billing_attempts, где есть все попытки.
    prompt_tokens: outcome.usage?.promptTokens ?? null,
    completion_tokens: outcome.usage?.completionTokens ?? null,
    total_tokens: outcome.usage?.totalTokens ?? null,
    attempt_count: outcome.attemptCount,
    retry_after_seconds: outcome.retryAfterSeconds ?? null,
    error_code: outcome.errorCode ?? null,
    error_msg: outcome.errorMsg ? sanitizeForLog(outcome.errorMsg, 500) : null,
    client_ip: entry.clientIp,
    source: entry.source,
    client_id: entry.clientId,
    billing_execution_id: entry.executionId,
    dedup_join: entry.joined ? 1 : 0,
    model_requested: entry.modelRequested,
    contour: entry.attribution.contour,
    token_id: entry.attribution.tokenId,
    department_id: entry.attribution.departmentId,
    employee_id: entry.attribution.employeeId,
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
      contour: entry.attribution.contour,
      ...(alertOpts.longRequestThresholdMs !== undefined ? { longRequestThresholdMs: alertOpts.longRequestThresholdMs } : {}),
      ...(alertOpts.upstreamLabel !== undefined ? { upstreamLabel: alertOpts.upstreamLabel } : {}),
    })
    .catch((err: unknown) => deps.logger.warn({ err: sanitizeErrorForLog(err) }, 'alert onEvent failed'));
}

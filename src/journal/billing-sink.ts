import type { AttemptObservation } from '../upstream/types.js';
import type { BillingRepo, BillingAttemptRecord } from '../storage/billing-repo.js';
import type { Payer } from '../billing/payer.js';
import { billingDay } from '../billing/billing-time.js';
import { estimateCost } from '../billing/estimate-cost.js';
import type { Attribution } from './attribution.js';

export interface BillingSinkParams {
  requestId: string;
  clientId: string;
  payer: Payer;
  /** Что просили у провайдера: для поиска цены, когда model_used в ответе отсутствует. */
  modelRequested: string;
  executionId: string;
  attribution: Attribution;
  /**
   * 'openrouter' — оценка по каталогу OpenRouter (id моделей совпадают);
   * 'none' — у провайдера свои id моделей, каталожной оценки нет (честное no_price, а не
   * правдоподобное число по чужому прайсу).
   */
  pricing: 'openrouter' | 'none';
}

/**
 * Sink наблюдений за попытками: превращает AttemptObservation в строку ledger'а.
 * Исключения гасит вызывающий (emitAttempt) — учёт не должен ломать проксирование.
 */
export function makeBillingSink(
  deps: { billing: BillingRepo; timezone: string },
  p: BillingSinkParams,
): (obs: AttemptObservation) => void {
  return (obs) => {
    const modelId = obs.modelUsed ?? p.modelRequested;
    // Цена, наблюдавшаяся на момент попытки, — не текущая: иначе вчерашний запрос
    // пересчитывался бы по сегодняшнему прайсу.
    const priceVersion = p.pricing === 'openrouter' ? deps.billing.priceVersionAt(modelId, obs.tsStarted) : null;
    const est = estimateCost(priceVersion, obs.usage, modelId);
    const record: BillingAttemptRecord = {
      execution_id: p.executionId,
      attempt_no: obs.attemptNo,
      request_id: p.requestId,
      client_id: p.clientId,
      payer_scope: p.payer.scope,
      api_key_fp: p.payer.fingerprint,
      ts_started: obs.tsStarted,
      ts_completed: obs.tsCompleted,
      billing_day: billingDay(obs.tsStarted, deps.timezone),
      http_status: obs.httpStatus,
      classification: obs.classification,
      model_requested: p.modelRequested,
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
      contour: p.attribution.contour,
      token_id: p.attribution.tokenId,
      department_id: p.attribution.departmentId,
      employee_id: p.attribution.employeeId,
      provider_id: p.attribution.providerId,
    };
    deps.billing.insertAttempt(record);
  };
}

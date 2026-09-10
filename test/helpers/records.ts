import type { RequestRecord } from '../../src/storage/requests-repo.js';
import type { BillingAttemptRecord } from '../../src/storage/billing-repo.js';

let seq = 0;

export function requestRecord(overrides: Partial<RequestRecord> = {}): RequestRecord {
  seq += 1;
  return {
    request_id: `r-${seq}`,
    idempotency_key: null,
    upstream_id: null,
    ts_received: Date.now(),
    ts_completed: Date.now() + 10,
    model_used: 'm',
    fallback_used: null,
    status: 'success',
    http_status: 200,
    latency_ms: 10,
    request_bytes: 1,
    response_bytes: 1,
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
    attempt_count: 1,
    retry_after_seconds: null,
    error_code: null,
    error_msg: null,
    client_ip: '127.0.0.1',
    source: 'x',
    client_id: 'x',
    ...overrides,
  };
}

export function attemptRecord(overrides: Partial<BillingAttemptRecord> = {}): BillingAttemptRecord {
  seq += 1;
  return {
    execution_id: `e-${seq}`,
    attempt_no: 1,
    request_id: `r-${seq}`,
    client_id: 'x',
    payer_scope: 'global',
    api_key_fp: 'fp',
    ts_started: Date.now(),
    ts_completed: Date.now() + 10,
    billing_day: '2026-09-01',
    http_status: 200,
    classification: 'success',
    model_requested: 'm',
    model_used: 'm',
    upstream_id: null,
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    cached_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    cost_usd: 0.01,
    upstream_inference_cost_usd: null,
    is_byok: null,
    usage_source: 'response',
    cost_est_usd: null,
    est_quality: null,
    est_price_version: null,
    usage_json: null,
    ...overrides,
  };
}

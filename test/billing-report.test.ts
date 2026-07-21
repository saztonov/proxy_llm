import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/storage/db.js';
import { BillingRepo, type BillingAttemptRecord } from '../src/storage/billing-repo.js';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { billingDay } from '../src/billing/billing-time.js';

const MSK = 'Europe/Moscow';

function attempt(over: Partial<BillingAttemptRecord> = {}): BillingAttemptRecord {
  const ts = over.ts_started ?? Date.parse('2026-07-10T09:00:00Z');
  return {
    execution_id: 'exec-' + Math.random().toString(36).slice(2),
    attempt_no: 1,
    request_id: 'req-1',
    client_id: 'passdesk',
    payer_scope: 'global',
    api_key_fp: 'abcdef0123456789',
    ts_started: ts,
    ts_completed: ts + 500,
    billing_day: billingDay(ts, MSK),
    http_status: 200,
    classification: 'success',
    model_requested: 'google/gemini-3.1-flash-lite',
    model_used: 'google/gemini-3.1-flash-lite',
    upstream_id: 'gen-x',
    prompt_tokens: 1000,
    completion_tokens: 100,
    total_tokens: 1100,
    cached_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: 0.001,
    upstream_inference_cost_usd: null,
    is_byok: 0,
    usage_source: 'response',
    cost_est_usd: null,
    est_quality: null,
    est_price_version: null,
    usage_json: null,
    ...over,
  };
}

describe('billing reports', () => {
  let dir: string;
  let handle: DbHandle;
  let billing: BillingRepo;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proxy_llm-report-'));
    handle = openDb(join(dir, 'test.db'));
    billing = new BillingRepo(handle.db);
  });

  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('splits days at the billing timezone midnight, not UTC', () => {
    // 20:59:59Z ещё 15 марта по Москве, 21:00:00Z — уже 16-е.
    billing.insertAttempt(attempt({ ts_started: Date.parse('2026-03-15T20:59:59.999Z'), cost_usd: 0.001 }));
    billing.insertAttempt(attempt({ ts_started: Date.parse('2026-03-15T21:00:00.000Z'), cost_usd: 0.002 }));

    const rows = billing.spendByDayClient('2026-03-01', '2026-03-31');
    expect(rows.map((r) => r.billing_day).sort()).toEqual(['2026-03-15', '2026-03-16']);
    const d15 = rows.find((r) => r.billing_day === '2026-03-15');
    const d16 = rows.find((r) => r.billing_day === '2026-03-16');
    expect(d15?.cost_actual_usd).toBeCloseTo(0.001, 12);
    expect(d16?.cost_actual_usd).toBeCloseTo(0.002, 12);
  });

  it('never merges measured cost with catalog estimates', () => {
    billing.insertAttempt(attempt({ cost_usd: 0.005, usage_source: 'response' }));
    billing.insertAttempt(
      attempt({ cost_usd: null, usage_source: 'missing', cost_est_usd: 0.004, est_quality: 'ok' }),
    );
    billing.insertAttempt(
      attempt({ cost_usd: null, usage_source: 'missing', cost_est_usd: null, est_quality: 'no_price' }),
    );

    const t = billing.spendTotals('2026-07-01', '2026-07-31');
    expect(t.cost_actual_usd).toBeCloseTo(0.005, 12);
    expect(t.cost_approx_usd).toBeCloseTo(0.004, 12);
    expect(t.approx_rows).toBe(1);
    expect(t.missing_rows).toBe(1);
    expect(t.upstream_attempts).toBe(3);
  });

  it('counts every paid attempt but only one execution per retry chain', () => {
    const exec = 'exec-retry';
    billing.insertAttempt(attempt({ execution_id: exec, attempt_no: 1, cost_usd: 0.001, completion_tokens: 10 }));
    billing.insertAttempt(attempt({ execution_id: exec, attempt_no: 2, cost_usd: 0.004, completion_tokens: 50 }));

    const t = billing.spendTotals('2026-07-01', '2026-07-31');
    expect(t.upstream_attempts).toBe(2);
    expect(t.executions).toBe(1);
    expect(t.cost_actual_usd).toBeCloseTo(0.005, 12);
    expect(t.output_tokens).toBe(60);

    // Отброшенная ретраем попытка — то, что не сойдётся с инвойсом.
    expect(billing.retryWasteUsd('2026-07-01', '2026-07-31')).toBeCloseTo(0.001, 12);
  });

  it('groups by client and by model', () => {
    billing.insertAttempt(attempt({ client_id: 'passdesk', model_used: 'a/model', cost_usd: 0.003 }));
    billing.insertAttempt(attempt({ client_id: 'fot', model_used: 'b/model', cost_usd: 0.007 }));
    billing.insertAttempt(attempt({ client_id: 'fot', model_used: 'a/model', cost_usd: 0.001 }));

    const byClient = billing.spendByClient('2026-07-01', '2026-07-31');
    expect(byClient[0]?.client_id).toBe('fot');
    expect(byClient[0]?.cost_actual_usd).toBeCloseTo(0.008, 12);
    expect(byClient.find((r) => r.client_id === 'passdesk')?.cost_actual_usd).toBeCloseTo(0.003, 12);

    const byModel = billing.spendByModel('2026-07-01', '2026-07-31');
    expect(byModel.find((r) => r.model === 'a/model')?.cost_actual_usd).toBeCloseTo(0.004, 12);
  });

  it('excludes attempts outside the requested range', () => {
    billing.insertAttempt(attempt({ ts_started: Date.parse('2026-06-30T12:00:00Z'), cost_usd: 9 }));
    billing.insertAttempt(attempt({ ts_started: Date.parse('2026-07-10T12:00:00Z'), cost_usd: 1 }));
    expect(billing.spendTotals('2026-07-01', '2026-07-31').cost_actual_usd).toBeCloseTo(1, 12);
  });
});

describe('billing dashboard endpoints', () => {
  let bundle: AppBundle;

  beforeEach(async () => {
    bundle = await buildApp(makeTestConfig());
  });

  afterEach(async () => {
    await bundle.app.close();
    bundle.db.close();
    bundle.stopWatchdog();
    bundle.stopDigest();
    bundle.stopPriceSync();
  });

  const auth = {
    authorization: 'Basic ' + Buffer.from('admin:test-pass').toString('base64'),
  };

  it('requires basic auth', async () => {
    for (const url of ['/dashboard/billing', '/dashboard/billing.json']) {
      expect((await bundle.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
  });

  it('renders html and json for the default 30-day range', async () => {
    const html = await bundle.app.inject({ method: 'GET', url: '/dashboard/billing', headers: auth });
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.body).toContain('proxy_llm — расходы');
    // Факт и оценка подписаны раздельно — их нельзя перепутать глазами.
    expect(html.body).toContain('факт, $');
    expect(html.body).toContain('≈ оценка, $');

    const json = await bundle.app.inject({ method: 'GET', url: '/dashboard/billing.json', headers: auth });
    expect(json.statusCode).toBe(200);
    const body = json.json();
    expect(body.timezone).toBe(MSK);
    expect(body.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Факт и оценка — разные поля, ни одно не является суммой другого.
    expect(body.totals).toHaveProperty('cost_actual_usd');
    expect(body.totals).toHaveProperty('cost_approx_usd');
  });

  it('rejects malformed and oversized ranges', async () => {
    const cases = [
      '/dashboard/billing?from=2026-13-01&to=2026-07-20',
      '/dashboard/billing?from=2026-07-20&to=2026-07-01',
      '/dashboard/billing?from=2020-01-01&to=2026-07-20',
      '/dashboard/billing.json?from=nonsense&to=2026-07-20',
    ];
    for (const url of cases) {
      const res = await bundle.app.inject({ method: 'GET', url, headers: auth });
      expect(res.statusCode, url).toBe(400);
    }
  });

  it('exposes an additive billing block in stats.json', async () => {
    const res = await bundle.app.inject({ method: 'GET', url: '/dashboard/stats.json', headers: auth });
    const body = res.json();
    // Существующие ключи на месте — на них завязаны внешние скрипты.
    expect(body).toHaveProperty('day');
    expect(body).toHaveProperty('perClientDay');
    expect(body.billing.timezone).toBe(MSK);
    expect(body.billing.priceSync).toBeNull();
    expect(body.billing.today).toHaveProperty('costActualUsd');
  });
});

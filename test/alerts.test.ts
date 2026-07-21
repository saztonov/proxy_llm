import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlertCooldown } from '../src/alerts/dedup.js';
import { AlertEngine } from '../src/alerts/rules.js';
import type { TelegramSender } from '../src/alerts/telegram.js';
import { openDb } from '../src/storage/db.js';
import { RequestsRepo, type RequestRecord } from '../src/storage/requests-repo.js';
import { BillingRepo, type BillingAttemptRecord } from '../src/storage/billing-repo.js';
import { billingDay } from '../src/billing/billing-time.js';
import { logger } from '../src/utils/logger.js';
import { makeTestConfig } from './helpers/test-config.js';

describe('AlertCooldown', () => {
  it('returns true on first call', () => {
    const c = new AlertCooldown(new Map([['k', 1000]]));
    expect(c.shouldSend('k', 1000)).toBe(true);
  });

  it('blocks when within cooldown window', () => {
    const c = new AlertCooldown(new Map([['k', 1000]]));
    c.markSent('k', 1000);
    expect(c.shouldSend('k', 1500)).toBe(false);
    expect(c.shouldSend('k', 1999)).toBe(false);
  });

  it('allows after cooldown expires', () => {
    const c = new AlertCooldown(new Map([['k', 1000]]));
    c.markSent('k', 1000);
    expect(c.shouldSend('k', 2001)).toBe(true);
  });

  it('cooldown 0 = no cooldown', () => {
    const c = new AlertCooldown(new Map([['k', 0]]));
    c.markSent('k', 1000);
    expect(c.shouldSend('k', 1000)).toBe(true);
    expect(c.shouldSend('k', 1001)).toBe(true);
  });

  it('different keys are independent', () => {
    const c = new AlertCooldown(new Map([['a', 1000], ['b', 1000]]));
    c.markSent('a', 1000);
    expect(c.shouldSend('a', 1500)).toBe(false);
    expect(c.shouldSend('b', 1500)).toBe(true);
  });
});

describe('AlertEngine.sendDailyDigest error breakdown', () => {
  const mk = (status: string, error_code: string | null, ts: number): RequestRecord => ({
    request_id: `r-${Math.random().toString(36).slice(2)}`,
    idempotency_key: null,
    upstream_id: null,
    ts_received: ts,
    ts_completed: ts + 10,
    model_used: 'm',
    fallback_used: null,
    status: status as RequestRecord['status'],
    http_status: 200,
    latency_ms: 10,
    request_bytes: 1,
    response_bytes: 1,
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: 2,
    attempt_count: 1,
    retry_after_seconds: null,
    error_code,
    error_msg: null,
    client_ip: '127.0.0.1',
    source: 'x',
    client_id: 'x',
  });

  const runDigest = async (records: RequestRecord[]): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), 'proxy_llm-digest-'));
    const handle = openDb(join(dir, 'd.db'));
    try {
      const repo = new RequestsRepo(handle.db);
      for (const r of records) repo.insert(r);
      const sent: string[] = [];
      const telegram = {
        send: async (t: string) => {
          sent.push(t);
        },
      } as unknown as TelegramSender;
      const engine = new AlertEngine(makeTestConfig(), telegram, repo, logger);
      await engine.sendDailyDigest();
      expect(sent).toHaveLength(1);
      return sent[0]!;
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('appends an error breakdown line sorted by count', async () => {
    const now = Date.now();
    const text = await runDigest([
      mk('malformed_success', 'finish_reason_error', now),
      mk('malformed_success', 'finish_reason_error', now),
      mk('malformed_success', 'finish_reason_error', now),
      mk('upstream_error', '400', now),
      mk('success', null, now),
    ]);
    expect(text).toContain('дневная сводка');
    expect(text).toContain('ошибок: 4');
    expect(text).toContain('Ошибки: malformed_success/finish_reason_error ×3, upstream_error/400 ×1');
  });

  it('omits the breakdown line when there are no errors', async () => {
    const now = Date.now();
    const text = await runDigest([mk('success', null, now), mk('success', null, now)]);
    expect(text).toContain('ошибок: 0');
    expect(text).not.toContain('Ошибки:');
  });
});

describe('AlertEngine.sendDailyDigest spend section', () => {
  const runDigest = async (
    seed: (billing: BillingRepo) => void,
  ): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), 'proxy_llm-digest-spend-'));
    const handle = openDb(join(dir, 'd.db'));
    try {
      const repo = new RequestsRepo(handle.db);
      const billing = new BillingRepo(handle.db);
      seed(billing);
      const sent: string[] = [];
      const telegram = {
        send: async (t: string) => {
          sent.push(t);
        },
      } as unknown as TelegramSender;
      const engine = new AlertEngine(makeTestConfig(), telegram, repo, logger, billing);
      await engine.sendDailyDigest();
      return sent[0]!;
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const tz = 'Europe/Moscow';

  const attemptAt = (tsMs: number, over: Partial<BillingAttemptRecord> = {}): BillingAttemptRecord => ({
    execution_id: 'e-' + Math.random().toString(36).slice(2),
    attempt_no: 1,
    request_id: 'r',
    client_id: 'passdesk',
    payer_scope: 'global',
    api_key_fp: 'fp',
    ts_started: tsMs,
    ts_completed: tsMs,
    billing_day: billingDay(tsMs, tz),
    http_status: 200,
    classification: 'success',
    model_requested: 'm',
    model_used: 'm',
    upstream_id: 'gen',
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    cached_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: 0.01,
    upstream_inference_cost_usd: null,
    is_byok: 0,
    usage_source: 'response',
    cost_est_usd: null,
    est_quality: null,
    est_price_version: null,
    usage_json: null,
    ...over,
  });

  it('reports yesterday, the incomplete current day and a 30-day total', async () => {
    const now = Date.now();
    const yesterdayTs = now - 24 * 60 * 60_000;
    const text = await runDigest((billing) => {
      billing.insertAttempt(attemptAt(yesterdayTs, { cost_usd: 0.02, client_id: 'passdesk' }));
      billing.insertAttempt(attemptAt(yesterdayTs, { cost_usd: 0.05, client_id: 'fot' }));
      billing.insertAttempt(attemptAt(now, { cost_usd: 0.01, client_id: 'fot' }));
    });

    expect(text).toContain('💰 Расходы');
    expect(text).toContain('Вчера');
    expect(text).toContain('$0.0700'); // 0.02 + 0.05 за вчера
    expect(text).toContain('неполные сутки');
    expect(text).toContain('$0.0800'); // 30 суток целиком
    expect(text).toContain('passdesk: $0.0200');
    expect(text).toContain('fot: $0.0500');
  });

  it('keeps estimates out of the actual figure and flags coverage gaps', async () => {
    const yesterdayTs = Date.now() - 24 * 60 * 60_000;
    const text = await runDigest((billing) => {
      billing.insertAttempt(attemptAt(yesterdayTs, { cost_usd: 0.01 }));
      billing.insertAttempt(
        attemptAt(yesterdayTs, { cost_usd: null, usage_source: 'missing', cost_est_usd: 0.5 }),
      );
      billing.insertAttempt(
        attemptAt(yesterdayTs, { cost_usd: null, usage_source: 'missing', cost_est_usd: null }),
      );
    });

    // Оценка $0.50 не влилась в факт $0.01 — она отдельным слагаемым с пометкой «оценка».
    expect(text).toContain('$0.0100 (+≈$0.5000 оценка)');
    expect(text).toContain('Попыток без стоимости за 30 суток: 1');
    expect(text).toContain('Синхронизация цен ещё ни разу не проходила');
  });

  it('omits the spend section when billing is not wired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proxy_llm-digest-nobill-'));
    const handle = openDb(join(dir, 'd.db'));
    try {
      const sent: string[] = [];
      const telegram = { send: async (t: string) => void sent.push(t) } as unknown as TelegramSender;
      const engine = new AlertEngine(
        makeTestConfig(),
        telegram,
        new RequestsRepo(handle.db),
        logger,
      );
      await engine.sendDailyDigest();
      expect(sent[0]).not.toContain('💰');
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

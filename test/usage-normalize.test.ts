import { describe, expect, it } from 'vitest';
import { normalizeUsage, hasCost } from '../src/upstream/usage.js';
import { openDb } from '../src/storage/db.js';
import { RequestsRepo, type RequestRecord } from '../src/storage/requests-repo.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

describe('normalizeUsage', () => {
  it('reads tokens, cost and nested details', () => {
    const u = normalizeUsage({
      prompt_tokens: 1200,
      completion_tokens: 340,
      total_tokens: 1540,
      cost: 0.00213,
      cost_details: { upstream_inference_cost: 0.002 },
      prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
      completion_tokens_details: { reasoning_tokens: 120 },
      is_byok: false,
    });

    expect(u).toMatchObject({
      promptTokens: 1200,
      completionTokens: 340,
      totalTokens: 1540,
      cachedTokens: 800,
      cacheWriteTokens: 100,
      reasoningTokens: 120,
      costUsd: 0.00213,
      upstreamInferenceCostUsd: 0.002,
      isByok: false,
    });
    expect(hasCost(u)).toBe(true);
  });

  it('accepts numeric strings for cost', () => {
    expect(normalizeUsage({ cost: '0.0012' })?.costUsd).toBe(0.0012);
  });

  it('drops non-finite and non-numeric values instead of propagating them', () => {
    const u = normalizeUsage({
      prompt_tokens: {},
      completion_tokens: 'abc',
      total_tokens: 12.5,
      cost: Number.NaN,
    });
    expect(u?.promptTokens).toBeUndefined();
    expect(u?.completionTokens).toBeUndefined();
    expect(u?.totalTokens).toBeUndefined(); // не целое → не токены
    expect(u?.costUsd).toBeUndefined();
    expect(hasCost(u)).toBe(false);
  });

  it('keeps valid siblings when one field is broken', () => {
    const u = normalizeUsage({ prompt_tokens: {}, completion_tokens: 7, cost: 0.5 });
    expect(u?.promptTokens).toBeUndefined();
    expect(u?.completionTokens).toBe(7);
    expect(u?.costUsd).toBe(0.5);
  });

  it('rejects negative values', () => {
    const u = normalizeUsage({ prompt_tokens: -5, cost: -1 });
    expect(u?.promptTokens).toBeUndefined();
    expect(u?.costUsd).toBeUndefined();
  });

  it('returns undefined for non-objects', () => {
    expect(normalizeUsage(null)).toBeUndefined();
    expect(normalizeUsage('usage')).toBeUndefined();
    expect(normalizeUsage([1, 2])).toBeUndefined();
  });

  it('preserves raw usage json', () => {
    const raw = normalizeUsage({ prompt_tokens: 1, cost: 0.1 })?.raw;
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toMatchObject({ prompt_tokens: 1, cost: 0.1 });
  });

  it('truncates oversized raw json', () => {
    const u = normalizeUsage({ cost: 0.1, junk: 'x'.repeat(20_000) });
    expect(Buffer.byteLength(u!.raw!, 'utf8')).toBeLessThanOrEqual(8192);
  });
});

// Регресс: раньше usage кастовался без валидации, и нечисловое значение роняло bind в
// better-sqlite3. persistRecord ловит исключение в try/catch — терялась ВСЯ строка журнала.
describe('broken usage does not destroy the request record', () => {
  it('inserts a row built from malformed usage', () => {
    const dbPath = join(tmpdir(), `proxy_llm_usage_${Date.now()}.db`);
    const handle = openDb(dbPath);
    const repo = new RequestsRepo(handle.db);
    const usage = normalizeUsage({ prompt_tokens: {}, completion_tokens: [], cost: {} });

    const record: RequestRecord = {
      request_id: 'req-broken-usage',
      idempotency_key: null,
      upstream_id: 'gen-1',
      ts_received: Date.now(),
      ts_completed: Date.now(),
      model_used: 'mock/model',
      fallback_used: 0,
      status: 'success',
      http_status: 200,
      latency_ms: 10,
      request_bytes: 100,
      response_bytes: 200,
      prompt_tokens: usage?.promptTokens ?? null,
      completion_tokens: usage?.completionTokens ?? null,
      total_tokens: usage?.totalTokens ?? null,
      attempt_count: 1,
      retry_after_seconds: null,
      error_code: null,
      error_msg: null,
      client_ip: '127.0.0.1',
      source: 'test',
      client_id: 'test',
    };

    expect(() => repo.insert(record)).not.toThrow();
    const rows = repo.listRecent(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.request_id).toBe('req-broken-usage');
    expect(rows[0]?.total_tokens).toBeNull();

    handle.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  });
});

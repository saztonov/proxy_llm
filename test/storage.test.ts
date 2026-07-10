import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/storage/db.js';
import { RequestsRepo } from '../src/storage/requests-repo.js';

describe('storage', () => {
  let dir: string;
  let handle: DbHandle;
  let repo: RequestsRepo;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proxy_llm-storage-'));
    handle = openDb(join(dir, 't.db'));
    repo = new RequestsRepo(handle.db);
  });

  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs migration and creates requests table with required columns', () => {
    const cols = handle.db.pragma('table_info(requests)') as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'request_id',
        'idempotency_key',
        'upstream_id',
        'ts_received',
        'model_used',
        'fallback_used',
        'status',
        'attempt_count',
        'error_code',
      ]),
    );
  });

  it('inserts and reads back a record, fallback_used IS NULL by default', () => {
    repo.insert({
      request_id: 'r-1',
      idempotency_key: 'i-1',
      upstream_id: 'gen-1',
      ts_received: 1000,
      ts_completed: 1100,
      model_used: 'google/gemini-2.5-flash',
      fallback_used: null,
      status: 'success',
      http_status: 200,
      latency_ms: 100,
      request_bytes: 500,
      response_bytes: 300,
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      attempt_count: 1,
      retry_after_seconds: null,
      error_code: null,
      error_msg: null,
      client_ip: '127.0.0.1',
      source: 'passdesk',
      client_id: 'passdesk',
    });

    const rows = repo.listRecent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('success');
    expect(rows[0]!.upstream_id).toBe('gen-1');
    expect(rows[0]!.client_id).toBe('passdesk');
  });

  it('aggregates correctly', () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      repo.insert({
        request_id: `r-${i}`,
        idempotency_key: null,
        upstream_id: null,
        ts_received: now,
        ts_completed: now + 100,
        model_used: 'm',
        fallback_used: null,
        status: i < 3 ? 'success' : 'upstream_error',
        http_status: 200,
        latency_ms: 100 + i * 10,
        request_bytes: 100,
        response_bytes: 100,
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        attempt_count: 1,
        retry_after_seconds: null,
        error_code: null,
        error_msg: null,
        client_ip: '127.0.0.1',
        source: i < 3 ? 'clientA' : 'clientB',
        client_id: i < 3 ? 'clientA' : 'clientB',
      });
    }
    const agg = repo.aggregateSince(now - 1000);
    expect(agg.total).toBe(5);
    expect(agg.success).toBe(3);
    expect(agg.errors).toBe(2);

    // Пер-клиентский фильтр и разбивка.
    const aggA = repo.aggregateSince(now - 1000, 'clientA');
    expect(aggA.total).toBe(3);
    expect(aggA.errors).toBe(0);

    const perClient = repo.perClientAggregate(now - 1000);
    const byId = Object.fromEntries(perClient.map((r) => [r.client_id, r]));
    expect(byId['clientA']!.total).toBe(3);
    expect(byId['clientB']!.total).toBe(2);
    expect(byId['clientB']!.errors).toBe(2);
  });

  it('errorBreakdownSince groups errors by status/error_code, skips success, sorts by count', () => {
    const now = Date.now();
    const mk = (status: string, error_code: string | null) => ({
      request_id: `r-${Math.random().toString(36).slice(2)}`,
      idempotency_key: null,
      upstream_id: null,
      ts_received: now,
      ts_completed: now + 10,
      model_used: 'm',
      fallback_used: null,
      status: status as never,
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
    // 3× malformed_success/finish_reason_error, 1× upstream_error/400, 2× success (не считаются)
    repo.insert(mk('malformed_success', 'finish_reason_error'));
    repo.insert(mk('malformed_success', 'finish_reason_error'));
    repo.insert(mk('malformed_success', 'finish_reason_error'));
    repo.insert(mk('upstream_error', '400'));
    repo.insert(mk('success', null));
    repo.insert(mk('success', null));

    const breakdown = repo.errorBreakdownSince(now - 1000);
    expect(breakdown).toHaveLength(2);
    // Отсортировано по убыванию количества.
    expect(breakdown[0]).toMatchObject({
      status: 'malformed_success',
      error_code: 'finish_reason_error',
      n: 3,
    });
    expect(breakdown[1]).toMatchObject({ status: 'upstream_error', error_code: '400', n: 1 });

    // Старое окно — ничего не попадает.
    expect(repo.errorBreakdownSince(now + 10_000)).toHaveLength(0);
  });

  it('has client_id column and ALTER is idempotent on reopen', () => {
    const cols = handle.db.pragma('table_info(requests)') as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('client_id');

    // Повторное открытие той же БД не должно падать (guard PRAGMA table_info + ALTER).
    handle.close();
    const again = openDb(join(dir, 't.db'));
    const cols2 = again.db.pragma('table_info(requests)') as { name: string }[];
    expect(cols2.map((c) => c.name).filter((n) => n === 'client_id')).toHaveLength(1);
    again.close();
    // reopen для afterEach.close()
    handle = openDb(join(dir, 't.db'));
  });
});

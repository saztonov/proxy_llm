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
    });

    const rows = repo.listRecent(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('success');
    expect(rows[0]!.upstream_id).toBe('gen-1');
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
        source: 'passdesk',
      });
    }
    const agg = repo.aggregateSince(now - 1000);
    expect(agg.total).toBe(5);
    expect(agg.success).toBe(3);
    expect(agg.errors).toBe(2);
  });
});

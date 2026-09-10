import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/storage/db.js';
import { RequestsRepo } from '../src/storage/requests-repo.js';
import { BillingRepo } from '../src/storage/billing-repo.js';
import { DirectoryRepo } from '../src/storage/directory-repo.js';
import { requestRecord, attemptRecord } from './helpers/records.js';

const NEW_TABLES = [
  'site_clients', 'site_tokens', 'departments', 'employees', 'providers', 'agent_tokens',
  'settings', 'admin_users', 'admin_sessions', 'admin_audit_log',
];
const ATTR = ['contour', 'token_id', 'department_id', 'employee_id'];

describe('migration 004', () => {
  let dir: string;
  let handle: DbHandle;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proxy_llm-004-'));
    handle = openDb(join(dir, 't.db'));
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const columns = (table: string): string[] =>
    (handle.db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);

  it('creates registry tables and journal attribution columns', () => {
    const rows = handle.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(NEW_TABLES));
    for (const t of ['requests', 'billing_attempts']) expect(columns(t)).toEqual(expect.arrayContaining(ATTR));
    expect(columns('billing_attempts')).toContain('provider_id');
  });

  it('is idempotent on reopen: every new column exists exactly once', () => {
    for (let i = 0; i < 2; i++) {
      handle.close();
      handle = openDb(join(dir, 't.db'));
    }
    for (const t of ['requests', 'billing_attempts']) {
      for (const c of ATTR) expect(columns(t).filter((n) => n === c)).toHaveLength(1);
    }
  });

  it('old-style records without new fields default to contour=site', () => {
    new RequestsRepo(handle.db).insert(requestRecord({ request_id: 'legacy' }));
    new BillingRepo(handle.db).insertAttempt(attemptRecord({ execution_id: 'legacy-e' }));
    const r = handle.db.prepare(`SELECT contour, token_id FROM requests WHERE request_id = 'legacy'`).get();
    const b = handle.db.prepare(`SELECT contour, provider_id FROM billing_attempts WHERE execution_id = 'legacy-e'`).get();
    expect(r).toEqual({ contour: 'site', token_id: null });
    expect(b).toEqual({ contour: 'site', provider_id: null });
  });

  it('enforces agent_tokens invariants and foreign keys', () => {
    const dept = new DirectoryRepo(handle.db).createDepartment(
      { slug: 'it', name: 'IT', max_concurrency: null, max_pending: null }, 1,
    );
    const ins = handle.db.prepare(`
      INSERT INTO agent_tokens (token_sha256, token_prefix, principal_type, department_id,
        employee_id, provider_id, model, created_at)
      VALUES (@h, 'p', @type, @dept, NULL, NULL, @model, 1)`);
    const h = (c: string): string => c.repeat(64);
    // model без provider_id
    expect(() => ins.run({ h: h('a'), type: 'department', dept, model: 'x' })).toThrow(/CHECK/);
    // принципал «отдел», но отдел не указан
    expect(() => ins.run({ h: h('b'), type: 'department', dept: null, model: null })).toThrow(/CHECK/);
    // несуществующий отдел
    expect(() => ins.run({ h: h('c'), type: 'department', dept: 999, model: null })).toThrow(/FOREIGN KEY/);
    ins.run({ h: h('d'), type: 'department', dept, model: null });
    // токен сайта на несуществующего клиента
    const site = handle.db.prepare(`INSERT INTO site_tokens (token_sha256, client_id, created_at) VALUES (?, 'ghost', 1)`);
    expect(() => site.run(h('e'))).toThrow(/FOREIGN KEY/);
  });

  it('aggregates: client_aborted is not an error, contour filters apply', () => {
    const repo = new RequestsRepo(handle.db);
    const now = Date.now();
    const agent = { contour: 'agent' as const, client_id: 'agent:emp:ivan', token_id: 7 };
    repo.insert(requestRecord({ ts_received: now, status: 'success', client_id: 's1' }));
    repo.insert(requestRecord({ ts_received: now, status: 'upstream_error', client_id: 's1' }));
    repo.insert(requestRecord({ ts_received: now, status: 'client_aborted', ...agent }));
    repo.insert(requestRecord({ ts_received: now, status: 'stream_incomplete', ...agent }));

    const all = repo.aggregateSince(now - 1000);
    expect(all.total).toBe(4);
    expect(all.errors).toBe(2);
    const site = repo.aggregateSince(now - 1000, undefined, 'site');
    expect(site.total).toBe(2);
    expect(site.errors).toBe(1);
    expect(repo.aggregateSince(now - 1000, 'agent:emp:ivan', 'agent').errors).toBe(1);

    expect(repo.recentStatuses(10, 'agent')).toEqual(['stream_incomplete', 'client_aborted']);
    expect(repo.errorBreakdownSince(now - 1000, 'agent').map((r) => r.status)).toEqual(['stream_incomplete']);
    expect(repo.perClientAggregate(now - 1000, 'site').map((r) => r.client_id)).toEqual(['s1']);
    expect(repo.listRecent(10, 'site')).toHaveLength(2);
    expect(repo.listRecentFiltered({ limit: 10, tokenId: 7 }).map((r) => r.contour)).toEqual(['agent', 'agent']);
  });
});

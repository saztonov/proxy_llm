import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/storage/db.js';
import { BillingRepo } from '../src/storage/billing-repo.js';
import { DirectoryRepo } from '../src/storage/directory-repo.js';
import { ProvidersRepo } from '../src/storage/providers-repo.js';
import { attemptRecord } from './helpers/records.js';

const D = '2026-09-01';
const NO_LIMITS = { max_concurrency: null, max_pending: null };

describe('billing reports by contour and agent attribution', () => {
  let dir: string;
  let handle: DbHandle;
  let billing: BillingRepo;
  let hr: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proxy_llm-bc-'));
    handle = openDb(join(dir, 't.db'));
    billing = new BillingRepo(handle.db);
    const d = new DirectoryRepo(handle.db);
    const it1 = d.createDepartment({ slug: 'it', name: 'IT', ...NO_LIMITS }, 1);
    hr = d.createDepartment({ slug: 'hr', name: 'HR', ...NO_LIMITS }, 1);
    const ivan = d.createEmployee({ login: 'ivan', display_name: 'Иван', email: null, department_id: it1, ...NO_LIMITS }, 1);
    const prov = new ProvidersRepo(handle.db).create({
      name: 'openrouter', base_url: 'https://openrouter.ai/api/v1', api_key_enc: null, api_key_fp: null,
      extra_headers_enc: null, usage_mode: 'auto', max_concurrency: null,
    }, 1);
    const agent = { contour: 'agent' as const, provider_id: prov };
    billing.insertAttempt(attemptRecord({ client_id: 'passdesk', cost_usd: 1 }));
    billing.insertAttempt(attemptRecord({ ...agent, client_id: 'agent:emp:ivan', token_id: 10, department_id: it1, employee_id: ivan, cost_usd: 2 }));
    billing.insertAttempt(attemptRecord({ ...agent, client_id: 'agent:dept:it', token_id: 11, department_id: it1, cost_usd: 3 }));
    billing.insertAttempt(attemptRecord({ ...agent, client_id: 'agent:dept:hr', token_id: 12, department_id: hr, cost_usd: 4, usage_source: 'missing' }));
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('totals split by contour; missing cost stays missing, not counted as fact', () => {
    expect(billing.spendTotals(D, D).cost_actual_usd).toBe(6);
    expect(billing.spendTotals(D, D, 'site').cost_actual_usd).toBe(1);
    const agent = billing.spendTotals(D, D, 'agent');
    expect(agent.cost_actual_usd).toBe(5);
    expect(agent.missing_rows).toBe(1);
    expect(billing.spendByClient(D, D, 'site').map((r) => r.client_id)).toEqual(['passdesk']);
  });

  it('by department folds employee tokens into their department', () => {
    const rows = billing.spendByDepartment(D, D);
    expect(Object.fromEntries(rows.map((r) => [r.department_name, r.cost_actual_usd]))).toEqual({ IT: 5, HR: 0 });
    expect(rows.find((r) => r.department_name === 'HR')!.missing_rows).toBe(1);
  });

  it('by employee, token, provider, site token and day', () => {
    expect(billing.spendByEmployee(D, D)).toEqual([expect.objectContaining({ employee_login: 'ivan', cost_actual_usd: 2 })]);
    expect(billing.spendByEmployee(D, D, hr)).toEqual([]);
    expect(billing.spendByAgentToken(D, D).map((r) => r.token_id).sort()).toEqual([10, 11, 12]);
    expect(billing.spendByProvider(D, D)).toEqual([expect.objectContaining({ provider_name: 'openrouter', cost_actual_usd: 5 })]);
    expect(billing.spendBySiteToken(D, D)).toEqual([expect.objectContaining({ client_id: 'passdesk', cost_actual_usd: 1 })]);
    expect(billing.spendByDayDepartment(D, D)).toHaveLength(2);
  });
});

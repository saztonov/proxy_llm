import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/storage/db.js';
import { BillingRepo } from '../src/storage/billing-repo.js';
import { DirectoryRepo } from '../src/storage/directory-repo.js';
import { ProvidersRepo } from '../src/storage/providers-repo.js';
import { AgentTokensRepo, type AgentTokenInput } from '../src/storage/agent-tokens-repo.js';
import { attemptRecord } from './helpers/records.js';

const D = '2026-09-01';
const NO_LIMITS = { max_concurrency: null, max_pending: null };

describe('billing reports by contour and agent attribution', () => {
  let dir: string;
  let handle: DbHandle;
  let billing: BillingRepo;
  let hr: number;
  let tok: Record<'ivan' | 'it' | 'hr' | 'idle' | 'revokedIdle' | 'revokedSpent', number>;

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
    const tokens = new AgentTokensRepo(handle.db);
    let n = 0;
    const issue = (owner: Pick<AgentTokenInput, 'principal_type' | 'department_id' | 'employee_id'>, label: string) => tokens.issue({
      token_sha256: String(++n).padStart(64, '0'), token_prefix: `pl_agent_${n}`, label, comment: '', provider_id: null, model: null,
      allowed_cidrs_json: null, expires_at: null, ...owner,
    }, 1);
    const emp = { principal_type: 'employee' as const, department_id: null, employee_id: ivan };
    const dept = (id: number) => ({ principal_type: 'department' as const, department_id: id, employee_id: null });
    tok = {
      ivan: issue(emp, 'ноутбук'), it: issue(dept(it1), ''), hr: issue(dept(hr), ''),
      idle: issue(dept(hr), 'простаивает'), revokedIdle: issue(emp, 'старый'), revokedSpent: issue(emp, 'отозван'),
    };
    tokens.revoke(tok.revokedIdle, 2);
    tokens.revoke(tok.revokedSpent, 2);

    const agent = { contour: 'agent' as const, provider_id: prov };
    billing.insertAttempt(attemptRecord({ client_id: 'passdesk', cost_usd: 1 }));
    billing.insertAttempt(attemptRecord({ ...agent, client_id: 'agent:emp:ivan', token_id: tok.ivan, department_id: it1, employee_id: ivan, cost_usd: 2 }));
    billing.insertAttempt(attemptRecord({ ...agent, client_id: 'agent:dept:it', token_id: tok.it, department_id: it1, cost_usd: 3 }));
    billing.insertAttempt(attemptRecord({ ...agent, client_id: 'agent:dept:hr', token_id: tok.hr, department_id: hr, cost_usd: 4, usage_source: 'missing' }));
    billing.insertAttempt(attemptRecord({ ...agent, client_id: 'agent:emp:ivan', token_id: tok.revokedSpent, department_id: it1, employee_id: ivan, cost_usd: 0.5 }));
    billing.insertAttempt(attemptRecord({ ...agent, client_id: 'agent:emp:ghost', token_id: 999, department_id: it1, cost_usd: 0.25 }));
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('totals split by contour; missing cost stays missing, not counted as fact', () => {
    expect(billing.spendTotals(D, D).cost_actual_usd).toBe(6.75);
    expect(billing.spendTotals(D, D, 'site').cost_actual_usd).toBe(1);
    const agent = billing.spendTotals(D, D, 'agent');
    expect(agent.cost_actual_usd).toBe(5.75);
    expect(agent.missing_rows).toBe(1);
    expect(billing.spendByClient(D, D, 'site').map((r) => r.client_id)).toEqual(['passdesk']);
  });

  it('by department folds employee tokens into their department', () => {
    const rows = billing.spendByDepartment(D, D);
    expect(Object.fromEntries(rows.map((r) => [r.department_name, r.cost_actual_usd]))).toEqual({ IT: 5.75, HR: 0 });
    expect(rows.find((r) => r.department_name === 'HR')!.missing_rows).toBe(1);
  });

  it('by agent token lists every issued key with its owner, plus spend by unknown keys', () => {
    const rows = billing.spendByAgentToken(D, D);
    const byId = new Map(rows.map((r) => [r.token_id, r]));
    expect([...byId.keys()].sort((a, b) => (a ?? 0) - (b ?? 0)))
      .toEqual([tok.ivan, tok.it, tok.hr, tok.idle, tok.revokedSpent, 999].sort((a, b) => a - b));
    expect(byId.has(tok.revokedIdle)).toBe(false);

    expect(byId.get(tok.ivan)).toMatchObject({
      token_known: 1, token_label: 'ноутбук', principal_type: 'employee',
      employee_login: 'ivan', employee_name: 'Иван', department_name: 'IT', cost_actual_usd: 2,
    });
    expect(byId.get(tok.it)).toMatchObject({ principal_type: 'department', department_name: 'IT', employee_id: null });
    expect(byId.get(tok.idle)).toMatchObject({ department_name: 'HR', token_label: 'простаивает', upstream_attempts: null, cost_actual_usd: null });
    expect(byId.get(tok.revokedSpent)!.token_revoked_at).toBe(2);
    expect(byId.get(999)).toMatchObject({ token_known: 0, department_name: null, cost_actual_usd: 0.25 });

    const sum = rows.reduce((acc, r) => acc + (r.cost_actual_usd ?? 0), 0);
    expect(sum).toBe(billing.spendTotals(D, D, 'agent').cost_actual_usd);
    expect(rows.reduce((acc, r) => acc + (r.upstream_attempts ?? 0), 0)).toBe(billing.spendTotals(D, D, 'agent').upstream_attempts);
    expect(rows[0]!.token_id).toBe(tok.it); // по убыванию факт + оценка
  });

  it('by employee, provider, site token and day', () => {
    expect(billing.spendByEmployee(D, D)).toEqual([expect.objectContaining({ employee_login: 'ivan', cost_actual_usd: 2.5 })]);
    expect(billing.spendByEmployee(D, D, hr)).toEqual([]);
    expect(billing.spendByProvider(D, D)).toEqual([expect.objectContaining({ provider_name: 'openrouter', cost_actual_usd: 5.75 })]);
    expect(billing.spendBySiteToken(D, D)).toEqual([expect.objectContaining({ client_id: 'passdesk', cost_actual_usd: 1 })]);
    expect(billing.spendByDayDepartment(D, D)).toHaveLength(2);
  });
});

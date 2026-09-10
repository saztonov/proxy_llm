import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/storage/db.js';
import { ConflictError } from '../src/storage/errors.js';
import { SiteClientsRepo } from '../src/storage/site-clients-repo.js';
import { SiteTokensRepo } from '../src/storage/site-tokens-repo.js';
import { DirectoryRepo } from '../src/storage/directory-repo.js';
import { ProvidersRepo } from '../src/storage/providers-repo.js';
import { AgentTokensRepo } from '../src/storage/agent-tokens-repo.js';
import { SettingsRepo } from '../src/storage/settings-repo.js';

const h = (c: string): string => c.repeat(64);
const NO_LIMITS = { max_concurrency: null, max_pending: null };

describe('registry repositories', () => {
  let dir: string;
  let handle: DbHandle;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proxy_llm-repos-'));
    handle = openDb(join(dir, 't.db'));
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const siteInput = (client_id: string) => ({
    client_id, default_model: null, allowed_models_json: null, fallback_models_json: null,
    ...NO_LIMITS, openrouter_api_key_enc: null, openrouter_api_key_fp: null,
    source: null, enabled: 1, imported_from: null,
  });

  it('site clients: create, conflict, insertIfAbsent keeps existing, null resets a field', () => {
    const repo = new SiteClientsRepo(handle.db);
    repo.create({ ...siteInput('alpha'), default_model: 'a/m' }, 1);
    expect(() => repo.create(siteInput('alpha'), 2)).toThrow(ConflictError);
    expect(repo.insertIfAbsent({ ...siteInput('alpha'), default_model: 'other' }, 3)).toBe(false);
    expect(repo.get('alpha')!.default_model).toBe('a/m');
    expect(repo.update('alpha', { allowed_models_json: '[]', max_concurrency: 2 }, 4)).toBe(true);
    expect(repo.update('alpha', { default_model: null }, 5)).toBe(true);
    expect(repo.get('alpha')).toMatchObject({ default_model: null, allowed_models_json: '[]', max_concurrency: 2, updated_at: 5 });
    expect(repo.update('ghost', { max_pending: 1 }, 6)).toBe(false);
  });

  it('site tokens: revoke once, import never resurrects a revoked hash', () => {
    new SiteClientsRepo(handle.db).create(siteInput('alpha'), 1);
    const repo = new SiteTokensRepo(handle.db);
    const tok = { token_sha256: h('a'), label: '', client_id: 'alpha' };
    const id = repo.issue({ ...tok, token_prefix: 'pl_site_abc' }, 1);
    expect(() => repo.issue({ ...tok, token_prefix: null }, 2)).toThrow(ConflictError);
    expect(repo.revoke(id, 3)).toBe(true);
    expect(repo.revoke(id, 4)).toBe(false);
    expect(repo.insertIfAbsent({ ...tok, token_prefix: null }, 5)).toBe(false);
    expect(repo.getByHash(h('a'))!.revoked_at).toBe(3);
    expect(repo.listActive()).toHaveLength(0);
  });

  it('directory: unique slug and case-insensitive login, counts', () => {
    const d = new DirectoryRepo(handle.db);
    const it1 = d.createDepartment({ slug: 'it', name: 'IT', ...NO_LIMITS }, 1);
    expect(() => d.createDepartment({ slug: 'it', name: 'Dup', ...NO_LIMITS }, 1)).toThrow(ConflictError);
    const emp = d.createEmployee({ login: 'Ivan', display_name: 'Иван', email: null, department_id: it1, ...NO_LIMITS }, 1);
    expect(() => d.createEmployee({ login: 'ivan', display_name: 'X', email: null, department_id: it1, ...NO_LIMITS }, 1)).toThrow(ConflictError);
    expect(d.getEmployeeByLogin('IVAN')!.id).toBe(emp);
    expect(d.listDepartments()[0]).toMatchObject({ slug: 'it', employees_count: 1, active_tokens: 0 });
    expect(d.updateEmployee(emp, { enabled: 0, email: 'i@x' }, 2)).toBe(true);
    expect(d.listEmployees({ departmentId: it1 })[0]).toMatchObject({ enabled: 0, email: 'i@x', department_slug: 'it' });
  });

  it('providers: optional key, unique name on create and rename', () => {
    const repo = new ProvidersRepo(handle.db);
    const base = { extra_headers_enc: null, max_concurrency: null };
    const a = repo.create({ ...base, name: 'ollama', base_url: 'http://127.0.0.1:11434/v1', api_key_enc: null, api_key_fp: null, usage_mode: 'none' }, 1);
    const b = repo.create({ ...base, name: 'openrouter', base_url: 'https://openrouter.ai/api/v1', api_key_enc: 'v1.x', api_key_fp: 'fp', usage_mode: 'auto' }, 1);
    expect(() => repo.update(b, { name: 'ollama' }, 2)).toThrow(ConflictError);
    expect(repo.get(a)).toMatchObject({ api_key_enc: null, usage_mode: 'none', enabled: 1 });
  });

  it('agent tokens: resolvable set follows revoke and owner enable flags', () => {
    const d = new DirectoryRepo(handle.db);
    const it1 = d.createDepartment({ slug: 'it', name: 'IT', max_concurrency: 10, max_pending: null }, 1);
    const emp = d.createEmployee({ login: 'ivan', display_name: 'Иван', email: null, department_id: it1, ...NO_LIMITS }, 1);
    const repo = new AgentTokensRepo(handle.db);
    const base = { label: '', provider_id: null, model: null, allowed_cidrs_json: null, expires_at: null };
    const deptTok = repo.issue({ ...base, token_sha256: h('1'), token_prefix: 'p1', principal_type: 'department', department_id: it1, employee_id: null }, 1);
    const empTok = repo.issue({ ...base, token_sha256: h('2'), token_prefix: 'p2', principal_type: 'employee', department_id: null, employee_id: emp }, 1);

    const rows = repo.listResolvable();
    expect(rows.map((r) => r.id).sort()).toEqual([deptTok, empTok].sort());
    expect(rows.find((r) => r.id === empTok)).toMatchObject({
      eff_department_id: it1, department_slug: 'it', employee_login: 'ivan', department_max_concurrency: 10,
    });
    expect(repo.list({ departmentId: it1 })).toHaveLength(2);

    d.updateEmployee(emp, { enabled: 0 }, 2);
    expect(repo.listResolvable().map((r) => r.id)).toEqual([deptTok]);
    d.updateEmployee(emp, { enabled: 1 }, 3);
    d.updateDepartment(it1, { enabled: 0 }, 4);
    expect(repo.listResolvable()).toHaveLength(0);
    d.updateDepartment(it1, { enabled: 1 }, 5);
    repo.revoke(deptTok, 6);
    expect(repo.listResolvable().map((r) => r.id)).toEqual([empTok]);
    expect(repo.list({})).toHaveLength(1);
    expect(repo.list({ includeRevoked: true })).toHaveLength(2);
  });

  it('settings: agent defaults roundtrip, null removes the key', () => {
    const s = new SettingsRepo(handle.db);
    const empty = { providerId: null, model: null, maxConcurrency: null, maxPending: null };
    expect(s.agentDefaults()).toEqual(empty);
    s.setAgentDefaults({ providerId: 3, model: 'anthropic/claude-sonnet-5', maxConcurrency: 4, maxPending: null }, 1);
    expect(s.agentDefaults()).toEqual({ providerId: 3, model: 'anthropic/claude-sonnet-5', maxConcurrency: 4, maxPending: null });
    s.setAgentDefaults(empty, 2);
    expect(s.all()).toEqual({});
  });
});

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/storage/db.js';
import { createRepos, type Repos } from '../src/storage/repos.js';
import { SecretBox } from '../src/storage/secret-box.js';
import { verifyPassword } from '../src/admin/auth/password.js';
import { AgentRegistry } from '../src/clients/agent-registry.js';
import {
  CliError, createAdmin, resetPassword, revokeSessions, addProvider, addDepartment, addEmployee,
  issueAgentToken, setAgentDefault, importClientsFile, rekey, main,
} from '../src/cli/admin.js';
import { makeTestConfig } from './helpers/test-config.js';
import { capturingLogger } from './helpers/silent-logger.js';

const STRONG = 'correct horse battery';

describe('admin CLI', () => {
  let dir: string;
  let handle: DbHandle;
  let repos: Repos;
  const box = new SecretBox('k'.repeat(32));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proxy_llm-cli-'));
    handle = openDb(join(dir, 't.db'));
    repos = createRepos(handle.db);
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates an admin only with a valid login and a strong password', async () => {
    await expect(createAdmin(repos, { login: 'root', password: 'short' })).rejects.toThrow(CliError);
    await expect(createAdmin(repos, { login: 'x', password: STRONG })).rejects.toThrow(CliError);
    const id = await createAdmin(repos, { login: 'Root', password: STRONG });
    const row = repos.adminUsers.get(id)!;
    expect(row.login).toBe('root');
    expect(await verifyPassword(STRONG, row.password_hash)).toBe(true);
    await expect(createAdmin(repos, { login: 'root', password: STRONG })).rejects.toThrow(/already exists/);
  });

  it('reset-password and revoke-sessions end active sessions immediately', async () => {
    const id = await createAdmin(repos, { login: 'root', password: STRONG });
    const session = (h: string, f: string) => repos.adminSessions.insert({
      admin_id: id, token_sha256: h, family_id: f, created_at: 1, expires_at: 9e15, absolute_expires_at: 9e15, ip: null, user_agent: null,
    });
    session('h1', 'f1');
    expect(await resetPassword(repos, { login: 'root', password: 'another strong pass' })).toBe(1);
    expect(repos.adminSessions.isFamilyActive('f1', id, Date.now())).toBe(false);
    session('h2', 'f2');
    expect(revokeSessions(repos, undefined)).toBe(1);
    expect(() => revokeSessions(repos, 'ghost')).toThrow(CliError);
  });

  it('provider URL policy: https anywhere, http only to private hosts with the flag', () => {
    const add = (name: string, baseUrl: string, extra: { allowInsecure?: boolean } = {}) =>
      addProvider(repos, box, { name, baseUrl, apiKey: 'k', ...extra });
    expect(() => add('a', 'http://api.example.com/v1')).toThrow(/https/);
    expect(() => add('b', 'http://127.0.0.1:11434/v1')).toThrow(/https/);
    expect(() => add('c', 'http://api.example.com/v1', { allowInsecure: true })).toThrow(/https/);
    expect(() => add('d', 'https://user:pass@x.example/v1')).toThrow(/credentials/);
    const local = add('ollama', 'http://127.0.0.1:11434/v1/', { allowInsecure: true });
    expect(repos.providers.get(local)!.base_url).toBe('http://127.0.0.1:11434/v1');
    const or = addProvider(repos, box, { name: 'or', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-secret' });
    const p = repos.providers.get(or)!;
    expect(p.api_key_enc).not.toContain('sk-or');
    expect(box.open(p.api_key_enc!)).toBe('sk-or-secret');
  });

  it('issues an agent key that the registry resolves to the global default', () => {
    addProvider(repos, box, { name: 'or', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' });
    addDepartment(repos, { slug: 'it', name: 'IT' });
    addEmployee(repos, { login: 'ivan', name: 'Иван', departmentSlug: 'it' });
    setAgentDefault(repos, { providerName: 'or', model: 'anthropic/claude-sonnet-5' });
    expect(() => issueAgentToken(repos, {})).toThrow(CliError);
    expect(() => issueAgentToken(repos, { employeeLogin: 'ivan', providerName: 'or' })).toThrow(/together/);
    expect(() => issueAgentToken(repos, { employeeLogin: 'ivan', allowedCidrs: ['bad'] })).toThrow(CliError);
    const t = issueAgentToken(repos, { employeeLogin: 'ivan', label: 'cursor' });
    expect(t.token).toMatch(/^pl_agent_[0-9a-f]{32}$/);
    const reg = new AgentRegistry({ config: makeTestConfig(), ...repos, secrets: box, logger: capturingLogger().logger });
    const p = reg.resolveToken(t.token)!;
    expect(p.clientIdForJournal).toBe('agent:emp:ivan');
    expect(p.target).toMatchObject({ model: 'anthropic/claude-sonnet-5', origin: 'global_default' });
    expect(p.target!.provider).toMatchObject({ kind: 'openrouter', usageMode: 'openrouter', apiKey: 'k' });
  });

  it('import-clients is idempotent; rekey re-encrypts everything or nothing', () => {
    const file = join(dir, 'clients.json');
    writeFileSync(file, JSON.stringify({ clients: [{ clientId: 'alpha', tokens: ['alpha-token-1234567890'], openrouterApiKey: 'sk-or-a' }] }));
    expect(importClientsFile(handle.db, repos, box, file)).toMatchObject({ clientsInserted: 1, tokensInserted: 1 });
    expect(importClientsFile(handle.db, repos, box, file)).toMatchObject({ clientsInserted: 0, tokensSkipped: 1 });
    addProvider(repos, box, { name: 'or', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-p' });
    const next = new SecretBox('n'.repeat(32));
    expect(rekey(handle.db, box, next)).toBe(2);
    const sealed = repos.siteClients.get('alpha')!.openrouter_api_key_enc!;
    expect(next.open(sealed)).toBe('sk-or-a');
    expect(() => rekey(handle.db, box, next)).toThrow();
    expect(repos.siteClients.get('alpha')!.openrouter_api_key_enc).toBe(sealed);
  });

  it('main prints usage and never accepts a password in argv', async () => {
    process.env.DB_PATH = join(dir, 't.db');
    try {
      const out: string[] = [];
      expect(await main([], (s) => out.push(s))).toBe(2);
      expect(out[0]).toContain('Usage');
      await expect(main(['create', '--login', 'root'], () => undefined, () => undefined)).rejects.toThrow(/password-stdin/);
      await expect(main(['create', '--login', 'root', '--password', 'x'])).rejects.toThrow();
    } finally {
      delete process.env.DB_PATH;
    }
  });
});

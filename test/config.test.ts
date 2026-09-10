import { describe, expect, it } from 'vitest';
import { loadConfig, estimateMemoryBudget } from '../src/config.js';

const BASE: NodeJS.ProcessEnv = {
  OPENROUTER_API_KEY: 'sk-or-test',
  OPENROUTER_MODEL: 'mock/model',
  DASHBOARD_BASIC_AUTH_PASS: 'pass',
  SECRETS_ENCRYPTION_KEY: 'x'.repeat(32),
  ADMIN_JWT_SECRET: 'y'.repeat(32),
};

describe('config', () => {
  it('loads with only mandatory variables; PROXY_INBOUND_TOKEN is optional now', () => {
    const c = loadConfig(BASE);
    expect(c.PROXY_INBOUND_TOKEN).toBeUndefined();
    expect(c.AGENT_QUEUE_CONCURRENCY).toBe(32);
    expect(c.AGENT_BODY_LIMIT_BYTES).toBe(1024 * 1024);
  });

  it('treats empty PROXY_INBOUND_TOKEN as absent, but still validates a set one', () => {
    expect(loadConfig({ ...BASE, PROXY_INBOUND_TOKEN: '' }).PROXY_INBOUND_TOKEN).toBeUndefined();
    expect(() => loadConfig({ ...BASE, PROXY_INBOUND_TOKEN: 'short' })).toThrow(/PROXY_INBOUND_TOKEN/);
  });

  it('requires both secrets with at least 32 chars', () => {
    const { SECRETS_ENCRYPTION_KEY: _s, ...noSecrets } = BASE;
    expect(() => loadConfig(noSecrets)).toThrow(/SECRETS_ENCRYPTION_KEY/);
    expect(() => loadConfig({ ...BASE, ADMIN_JWT_SECRET: 'short' })).toThrow(/ADMIN_JWT_SECRET/);
  });

  it('derives ADMIN_COOKIE_SECURE from NODE_ENV unless set explicitly', () => {
    expect(loadConfig(BASE).ADMIN_COOKIE_SECURE).toBe(true);
    expect(loadConfig({ ...BASE, NODE_ENV: 'development' }).ADMIN_COOKIE_SECURE).toBe(false);
    expect(loadConfig({ ...BASE, ADMIN_COOKIE_SECURE: 'false' }).ADMIN_COOKIE_SECURE).toBe(false);
  });

  it('rejects an agent deadline shorter than one attempt', () => {
    expect(() =>
      loadConfig({ ...BASE, AGENT_REQUEST_DEADLINE_MS: '1000', AGENT_UPSTREAM_ATTEMPT_TIMEOUT_MS: '5000' }),
    ).toThrow(/AGENT_REQUEST_DEADLINE_MS/);
  });

  it('memory budget: warn mode loads, fail mode refuses to start', () => {
    const heavy = { ...BASE, QUEUE_MAX_PENDING: '40', MEMORY_BUDGET_BYTES: String(100 * 1024 * 1024) };
    const c = loadConfig(heavy);
    expect(estimateMemoryBudget(c).ok).toBe(false);
    expect(() => loadConfig({ ...heavy, MEMORY_BUDGET_MODE: 'fail' })).toThrow(/memory budget exceeded/);
  });

  it('production-like limits fit into the default budget', () => {
    const c = loadConfig({ ...BASE, QUEUE_MAX_PENDING: '6' });
    const m = estimateMemoryBudget(c);
    expect(m.ok).toBe(true);
    expect(m.estimatedBytes).toBe(6 * 27_262_976 + 64 * 1024 * 1024 * 2 + 64 * 1024 * 1024);
  });
});

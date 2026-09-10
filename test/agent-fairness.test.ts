import { describe, expect, it, afterEach } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import type { Config } from '../src/config.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, chatSuccessBody, type MockServer } from './helpers/mock-openrouter.js';
import { seedAgent } from './helpers/agent-seed.js';
import { generateToken } from '../src/clients/tokens.js';

const chat = { messages: [{ role: 'user', content: 'hi' }] };

describe('agent contour: capacity and isolation', () => {
  let up: MockServer;
  let b: AppBundle;
  let inflight = 0;
  let maxInflight = 0;

  const start = async (delayMs: number, overrides: Partial<Config> = {}): Promise<string> => {
    inflight = 0;
    maxInflight = 0;
    up = await startMockOpenRouter(async (_q, res) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, delayMs));
      inflight -= 1;
      jsonResponse(res, 200, chatSuccessBody());
    });
    b = await buildApp(makeTestConfig({ OPENROUTER_BASE_URL: up.baseUrl, REQUEST_DEADLINE_MS: 8000, UPSTREAM_ATTEMPT_TIMEOUT_MS: 6000, ...overrides }));
    return `${up.baseUrl}/v1`;
  };
  afterEach(async () => {
    await b.app.close();
    b.db.close();
    b.stopTickers();
    await up.close();
  });

  const agent = (token: string) =>
    b.app.inject({ method: 'POST', url: '/agent/v1/chat/completions', headers: { authorization: `Bearer ${token}` }, payload: chat });
  const site = () =>
    b.app.inject({ method: 'POST', url: '/api/v1/chat/completions', headers: { authorization: 'Bearer test-token-1234567890abcdef' }, payload: chat });

  it('serves 40 concurrent users with default limits', async () => {
    const baseUrl = await start(200);
    const users = Array.from({ length: 40 }, () => seedAgent(b, { baseUrl }));
    const codes = await Promise.all(users.map((u) => agent(u.token).then((r) => r.statusCode)));
    expect(codes.filter((c) => c !== 200)).toEqual([]);
    expect(maxInflight).toBeGreaterThan(20);
    expect(maxInflight).toBeLessThanOrEqual(32);
    expect(b.agentFairness.snapshot().globalActive).toBe(0);
  });

  it('a full agent queue does not block sites', async () => {
    const baseUrl = await start(400, { AGENT_QUEUE_CONCURRENCY: 1, AGENT_QUEUE_MAX_PENDING: 1 });
    const users = [seedAgent(b, { baseUrl }), seedAgent(b, { baseUrl }), seedAgent(b, { baseUrl })];
    const [a1, a2, a3, s] = await Promise.all([...users.map((u) => agent(u.token)), site()]);
    const agentCodes = [a1!, a2!, a3!].map((r) => r.statusCode);
    expect(agentCodes).toContain(503);
    expect([a1!, a2!, a3!].find((r) => r.statusCode === 503)!.json().error.code).toBe('server_overloaded');
    expect(s!.statusCode).toBe(200);
  });

  it('two keys of one employee share one slot', async () => {
    const baseUrl = await start(400);
    const first = seedAgent(b, { baseUrl, maxConcurrency: 1, maxPending: 1 });
    const t = generateToken('agent');
    b.repos.agentTokens.issue({
      token_sha256: t.sha256, token_prefix: t.prefix, label: 'second', principal_type: 'employee',
      department_id: null, employee_id: first.employeeId, provider_id: null, model: null, allowed_cidrs_json: null, expires_at: null,
    }, Date.now());
    b.agentRegistry.reload();
    const rs = await Promise.all([agent(first.token), agent(t.plaintext), agent(t.plaintext)]);
    const rejected = rs.filter((r) => r.statusCode === 429);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.json().error.code).toBe('too_many_parallel_requests');
  });

  it('provider concurrency limit caps parallel calls to one provider', async () => {
    const baseUrl = await start(150);
    const users = Array.from({ length: 6 }, () => seedAgent(b, { baseUrl, providerMaxConcurrency: 2 }));
    const codes = await Promise.all(users.map((u) => agent(u.token).then((r) => r.statusCode)));
    expect(codes).toEqual([200, 200, 200, 200, 200, 200]);
    expect(maxInflight).toBeLessThanOrEqual(2);
  });

  it('rate limit is per key owner', async () => {
    const baseUrl = await start(0, { AGENT_RATE_LIMIT_MAX: 2 });
    const a = seedAgent(b, { baseUrl });
    const other = seedAgent(b, { baseUrl });
    expect((await agent(a.token)).statusCode).toBe(200);
    expect((await agent(a.token)).statusCode).toBe(200);
    const limited = await agent(a.token);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limit_exceeded');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await agent(other.token)).statusCode).toBe(200);
  });
});

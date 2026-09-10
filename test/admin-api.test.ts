import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, chatSuccessBody, type MockServer } from './helpers/mock-openrouter.js';
import { adminCall, loginAs, seedAdmin, type AdminSession } from './helpers/admin-session.js';

const msgs = [{ role: 'user', content: 'hi' }];

describe('admin API end to end', () => {
  let up: MockServer;
  let b: AppBundle;
  let s: AdminSession;

  beforeAll(async () => {
    up = await startMockOpenRouter((req, res) => {
      if ((req.url ?? '').endsWith('/models')) jsonResponse(res, 200, { data: [{ id: 'm-1' }, { id: 'm-2' }] });
      else jsonResponse(res, 200, chatSuccessBody());
    });
    b = await buildApp(makeTestConfig({ OPENROUTER_BASE_URL: up.baseUrl }));
    await seedAdmin(b);
    s = await loginAs(b);
  });
  afterAll(async () => {
    await b.app.close();
    b.db.close();
    b.stopTickers();
    await up.close();
  });

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) => adminCall(b, s, method, url, payload);
  const siteChat = (token: string, model?: string) =>
    b.app.inject({ method: 'POST', url: '/api/v1/chat/completions', headers: { authorization: `Bearer ${token}` }, payload: { ...(model ? { model } : {}), messages: msgs } });
  const agentChat = (token: string) =>
    b.app.inject({ method: 'POST', url: '/agent/v1/chat/completions', headers: { authorization: `Bearer ${token}` }, payload: { model: 'anything', messages: msgs } });

  it('sites: a new token works at once, policy edits apply, revocation needs no restart', async () => {
    const created = await call('POST', '/admin/api/sites', {
      clientId: 'portal', defaultModel: 'a/default', allowedModels: ['a/chosen'], openrouterApiKey: 'sk-or-portal-secret',
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('sk-or-portal-secret');
    expect(created.json().site).toMatchObject({ clientId: 'portal', hasOpenrouterApiKey: true, effective: { defaultModel: 'a/default', allowedModels: ['a/chosen'] } });

    const issued = await call('POST', '/admin/api/sites/portal/tokens', { label: 'prod' });
    expect(issued.statusCode).toBe(201);
    const { plaintext, token } = issued.json() as { plaintext: string; token: { id: number } };
    expect(plaintext).toMatch(/^pl_site_[0-9a-f]{32}$/);
    expect((await siteChat(plaintext, 'a/chosen')).statusCode).toBe(200);
    expect(up.requests.at(-1)!.headers.authorization).toBe('Bearer sk-or-portal-secret');
    expect((await siteChat(plaintext, 'x/other')).statusCode).toBe(400);

    expect((await call('PATCH', '/admin/api/sites/portal', { allowedModels: ['*'] })).statusCode).toBe(200);
    expect((await siteChat(plaintext, 'x/other')).statusCode).toBe(200);
    expect((await call('GET', '/admin/api/sites')).body).not.toContain(plaintext);

    expect((await call('POST', `/admin/api/sites/portal/tokens/${token.id}/revoke`)).statusCode).toBe(200);
    expect((await siteChat(plaintext)).statusCode).toBe(401);
    expect((await call('POST', '/admin/api/sites', { clientId: 'portal' })).statusCode).toBe(409);

    // Legacy-токен из env стал обычным токеном passdesk и выключается вместе с клиентом.
    expect((await siteChat('test-token-1234567890abcdef')).statusCode).toBe(200);
    await call('PATCH', '/admin/api/sites/passdesk', { enabled: false });
    expect((await siteChat('test-token-1234567890abcdef')).statusCode).toBe(401);
    await call('PATCH', '/admin/api/sites/passdesk', { enabled: true });
  });

  it('directory, providers and agent keys: an issued key works on /agent/v1 at once', async () => {
    const dept = (await call('POST', '/admin/api/departments', { slug: 'dev', name: 'Разработка' })).json().department;
    const emp = (await call('POST', '/admin/api/employees', { login: 'ivan', displayName: 'Иван', departmentId: dept.id })).json().employee;
    const prov = await call('POST', '/admin/api/providers', {
      name: 'mock', baseUrl: `${up.baseUrl}/v1`, apiKey: 'sk-mock-provider', extraHeaders: { 'X-Org': 'acme' },
    });
    expect(prov.statusCode).toBe(201);
    expect(prov.body).not.toContain('sk-mock-provider');
    expect(prov.body).not.toContain('acme');
    const provider = prov.json().provider as { id: number; extraHeaderNames: string[] };
    expect(provider.extraHeaderNames).toEqual(['X-Org']);

    const bad = await call('POST', '/admin/api/providers', { name: 'bad', baseUrl: 'http://api.example.com/v1', extraHeaders: { Authorization: 'x' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.issues.map((i: { path: string }) => i.path)).toEqual(['baseUrl', 'extraHeaders']);

    const test = await call('POST', `/admin/api/providers/${provider.id}/test`);
    expect(test.json()).toMatchObject({ ok: true, modelsCount: 2, sampleModels: ['m-1', 'm-2'] });
    expect(up.requests.at(-1)!.headers.authorization).toBe('Bearer sk-mock-provider');

    await call('PUT', '/admin/api/settings/agent-defaults', { providerId: provider.id, model: 'global/model', maxConcurrency: null, maxPending: null });
    const issued = await call('POST', '/admin/api/agent-tokens', { principalType: 'employee', employeeId: emp.id, label: 'cursor' });
    expect(issued.statusCode).toBe(201);
    const { plaintext, token, agentBaseUrl } = issued.json();
    expect(token.effective).toMatchObject({ model: 'global/model', origin: 'global_default' });
    expect(agentBaseUrl).toBe('http://admin.test/agent/v1');

    expect((await agentChat(plaintext)).statusCode).toBe(200);
    let sent = up.requests.at(-1)!;
    expect(JSON.parse(sent.body).model).toBe('global/model');
    expect(sent.headers['x-org']).toBe('acme');

    await call('PATCH', `/admin/api/agent-tokens/${token.id}`, { providerId: provider.id, model: 'pinned/model' });
    expect((await agentChat(plaintext)).statusCode).toBe(200);
    sent = up.requests.at(-1)!;
    expect(JSON.parse(sent.body).model).toBe('pinned/model');

    expect((await call('PATCH', `/admin/api/providers/${provider.id}`, { enabled: false })).statusCode).toBe(409);
    await call('PATCH', `/admin/api/employees/${emp.id}`, { enabled: false });
    expect((await agentChat(plaintext)).statusCode).toBe(401);
    await call('PATCH', `/admin/api/employees/${emp.id}`, { enabled: true });
    await call('POST', `/admin/api/agent-tokens/${token.id}/revoke`);
    expect((await agentChat(plaintext)).statusCode).toBe(401);

    const mismatched = await call('POST', '/admin/api/agent-tokens', { principalType: 'employee', employeeId: emp.id, providerId: provider.id });
    expect(mismatched.statusCode).toBe(400);
  });

  it('stats, requests and audit reflect what happened, without secrets', async () => {
    const byClient = await call('GET', '/admin/api/stats/spend?by=client');
    expect(byClient.statusCode).toBe(200);
    expect(byClient.json().rows.length).toBeGreaterThan(0);
    expect((await call('GET', '/admin/api/stats/spend?by=department')).json().contour).toBe('agent');
    expect((await call('GET', '/admin/api/stats/spend?from=2026-02-01&to=2026-01-01')).statusCode).toBe(400);
    expect((await call('GET', '/admin/api/stats/summary')).json()).toHaveProperty('agents.day.total');
    const agentReqs = (await call('GET', '/admin/api/requests?contour=agent&limit=5')).json().requests as Array<{ contour: string }>;
    expect(agentReqs.length).toBeGreaterThan(0);
    expect(agentReqs.every((r) => r.contour === 'agent')).toBe(true);

    const audit = await call('GET', '/admin/api/audit?limit=200');
    expect(audit.body).not.toMatch(/pl_(site|agent)_[0-9a-f]{32}/);
    expect(audit.body).not.toContain('sk-');
    expect(audit.json().entries.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['site.create', 'site_token.issue', 'site_token.revoke', 'provider.create', 'agent_token.issue', 'settings.update']),
    );
  });
});

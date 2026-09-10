import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, chatSuccessBody, type MockServer } from './helpers/mock-openrouter.js';
import { seedAgent } from './helpers/agent-seed.js';

const chat = { messages: [{ role: 'user', content: 'hi' }] };

describe('agent contour: authentication and scope', () => {
  let up: MockServer;
  let b: AppBundle;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    up = await startMockOpenRouter((_req, res) => jsonResponse(res, 200, chatSuccessBody()));
    b = await buildApp(makeTestConfig({ OPENROUTER_BASE_URL: up.baseUrl }));
    baseUrl = `${up.baseUrl}/v1`;
    token = seedAgent(b, { baseUrl }).token;
  });
  afterAll(async () => {
    await b.app.close();
    b.db.close();
    b.stopTickers();
    await up.close();
  });

  const post = (auth?: string, url = '/agent/v1/chat/completions') =>
    b.app.inject({ method: 'POST', url, headers: auth ? { authorization: auth } : {}, payload: chat });
  const get = (url: string, t = token) => b.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${t}` } });

  it('401 in OpenAI format for a missing or wrong key', async () => {
    const miss = await post();
    expect(miss.statusCode).toBe(401);
    expect(miss.json().error).toMatchObject({ code: 'invalid_api_key', type: 'invalid_request_error' });
    expect((await post('Bearer pl_agent_00000000000000000000000000000000')).statusCode).toBe(401);
  });

  it('keys of one contour do not work in the other', async () => {
    expect((await post('Bearer test-token-1234567890abcdef')).statusCode).toBe(401);
    const onSite = await b.app.inject({ method: 'POST', url: '/api/v1/chat/completions', headers: { authorization: `Bearer ${token}` }, payload: chat });
    expect(onSite.statusCode).toBe(401);
    expect(onSite.json().error.code).toBe('unauthorized');
  });

  it('valid key works; /models lists the pinned model and the default alias', async () => {
    expect((await post(`Bearer ${token}`)).statusCode).toBe(200);
    expect((await get('/agent/v1/models')).json().data.map((m: { id: string }) => m.id)).toEqual(['target/model', 'default']);
    expect((await get('/agent/v1/models/vendor/any-name')).json()).toMatchObject({ id: 'vendor/any-name', object: 'model' });
  });

  it('unknown endpoints: 401 without a key, 404 with one', async () => {
    expect((await post(undefined, '/agent/v1/embeddings')).statusCode).toBe(401);
    const r = await post(`Bearer ${token}`, '/agent/v1/embeddings');
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('unknown_endpoint');
  });

  it('revoked, expired and disabled-owner keys stop working without a restart', async () => {
    const revoked = seedAgent(b, { baseUrl });
    b.repos.agentTokens.revoke(revoked.tokenId, Date.now());
    b.agentRegistry.reload();
    expect((await post(`Bearer ${revoked.token}`)).statusCode).toBe(401);

    const expired = seedAgent(b, { baseUrl, expiresAt: Date.now() - 1 });
    expect((await post(`Bearer ${expired.token}`)).statusCode).toBe(401);

    const owner = seedAgent(b, { baseUrl });
    b.repos.directory.updateEmployee(owner.employeeId!, { enabled: 0 }, Date.now());
    b.agentRegistry.reload();
    expect((await post(`Bearer ${owner.token}`)).statusCode).toBe(401);
  });

  it('network allowlist is enforced per key', async () => {
    const blocked = seedAgent(b, { baseUrl, allowedCidrs: ['10.0.0.0/8'] });
    const r = await post(`Bearer ${blocked.token}`);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('ip_not_allowed');
    const allowed = seedAgent(b, { baseUrl, allowedCidrs: ['127.0.0.1'] });
    expect((await post(`Bearer ${allowed.token}`)).statusCode).toBe(200);
  });

  it('503 agent_not_configured when the provider behind the key is disabled', async () => {
    const pinned = seedAgent(b, { baseUrl, tokenModel: 'pinned/model' });
    b.repos.providers.update(pinned.providerId, { enabled: 0 }, Date.now());
    b.agentRegistry.reload();
    const r = await post(`Bearer ${pinned.token}`);
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('agent_not_configured');
    expect((await get('/agent/v1/models', pinned.token)).json().data).toEqual([]);
  });
});

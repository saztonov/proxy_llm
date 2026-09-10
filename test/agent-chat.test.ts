import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { ServerResponse } from 'node:http';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, chatSuccessBody, type MockServer } from './helpers/mock-openrouter.js';
import { seedAgent } from './helpers/agent-seed.js';

type Reply = (res: ServerResponse) => void;

describe('agent contour: non-streaming chat', () => {
  let up: MockServer;
  let b: AppBundle;
  let next: Reply;

  beforeEach(async () => {
    next = (res) => jsonResponse(res, 200, chatSuccessBody());
    up = await startMockOpenRouter((_req, res) => next(res));
    b = await buildApp(makeTestConfig({ OPENROUTER_BASE_URL: up.baseUrl }));
  });
  afterEach(async () => {
    await b.app.close();
    b.db.close();
    b.stopTickers();
    await up.close();
  });

  const post = (token: string, payload: Record<string, unknown>) =>
    b.app.inject({ method: 'POST', url: '/agent/v1/chat/completions', headers: { authorization: `Bearer ${token}` }, payload });

  it('replaces the requested model and strips routing fields, keeps tools', async () => {
    const s = seedAgent(b, { baseUrl: `${up.baseUrl}/v1`, model: 'target/model' });
    const r = await post(s.token, {
      model: 'gpt-4o', models: ['a', 'b'], provider: { order: ['x'] }, stream_options: { include_usage: true },
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.statusCode).toBe(200);
    const sent = up.requests.at(-1)!;
    expect(sent.url).toBe('/v1/chat/completions');
    expect(sent.headers['authorization']).toBe('Bearer sk-provider-test-key');
    expect(sent.headers['x-title']).toBeUndefined();
    const body = JSON.parse(sent.body);
    expect(body.model).toBe('target/model');
    expect(body).not.toHaveProperty('models');
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('stream_options');
    expect(body.tools).toHaveLength(1);

    const row = b.db.db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    expect(row).toMatchObject({ contour: 'agent', model_requested: 'gpt-4o', token_id: s.tokenId, department_id: s.departmentId, employee_id: s.employeeId, status: 'success', source: 'agent' });
    expect(String(row.client_id)).toMatch(/^agent:emp:/);
    const ba = b.db.db.prepare('SELECT * FROM billing_attempts ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    expect(ba).toMatchObject({ contour: 'agent', provider_id: s.providerId, model_requested: 'target/model', est_quality: 'no_price' });
    expect(String(ba.payer_scope)).toMatch(/^provider:/);
  });

  it('a key with its own model overrides the global default', async () => {
    const byDefault = seedAgent(b, { baseUrl: `${up.baseUrl}/v1`, model: 'global/model' });
    const pinned = seedAgent(b, { baseUrl: `${up.baseUrl}/v1`, tokenModel: 'pinned/model' });
    await post(byDefault.token, { messages: [{ role: 'user', content: 'a' }] });
    await post(pinned.token, { messages: [{ role: 'user', content: 'b' }] });
    expect(up.requests.map((q) => JSON.parse(q.body).model)).toEqual(['global/model', 'pinned/model']);
  });

  it('provider errors: OpenAI-format bodies pass through, auth problems become 502, HTML is wrapped', async () => {
    const s = seedAgent(b, { baseUrl: `${up.baseUrl}/v1` });
    const msg = { messages: [{ role: 'user', content: 'x' }] };

    next = (res) => jsonResponse(res, 400, { error: { message: 'bad param', type: 'invalid_request_error', code: 'bad' } });
    const bad = await post(s.token, msg);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toBe('bad param');

    next = (res) => jsonResponse(res, 401, { error: { message: 'Incorrect API key sk-provider-test-key' } }, { 'www-authenticate': 'Bearer' });
    const auth = await post(s.token, msg);
    expect(auth.statusCode).toBe(502);
    expect(auth.json().error.code).toBe('upstream_auth_failed');
    expect(auth.body).not.toContain('sk-provider-test-key');
    expect(auth.headers['www-authenticate']).toBeUndefined();

    next = (res) => { res.statusCode = 404; res.setHeader('content-type', 'text/html'); res.end('<html>gateway</html>'); };
    const html = await post(s.token, msg);
    expect(html.statusCode).toBe(404);
    expect(html.json().error.code).toBe('upstream_error');
  });

  it('400 for a body without messages, before any upstream call', async () => {
    const s = seedAgent(b, { baseUrl: `${up.baseUrl}/v1` });
    const r = await post(s.token, { model: 'x' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.param).toBe('messages');
    expect(up.requests).toHaveLength(0);
  });
});

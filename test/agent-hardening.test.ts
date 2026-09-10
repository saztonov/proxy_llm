import { describe, expect, it, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { connect, createServer, type AddressInfo } from 'node:net';
import { buildApp, type AppBundle } from '../src/app.js';
import type { Config } from '../src/config.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, chatSuccessBody, type MockServer } from './helpers/mock-openrouter.js';
import { seedAgent, type SeedOptions } from './helpers/agent-seed.js';
import { chatChunk, sseResponse } from './helpers/mock-openai.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const msgs = [{ role: 'user', content: 'hi' }];

const waitFor = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address() as AddressInfo;
    s.close(() => resolve(port));
  });
});

describe('agent contour: security hardening', () => {
  let up: MockServer;
  let b: AppBundle;
  let handler: Handler = (_q, res) => jsonResponse(res, 200, chatSuccessBody());

  const start = async (overrides: Partial<Config> = {}, seed: Partial<SeedOptions> = {}) => {
    up = await startMockOpenRouter((req, res) => handler(req, res));
    b = await buildApp(makeTestConfig({ OPENROUTER_BASE_URL: up.baseUrl, ...overrides }));
    return seedAgent(b, { baseUrl: `${up.baseUrl}/v1`, ...seed });
  };
  afterEach(async () => {
    await b.app.close();
    b.db.close();
    b.stopTickers();
    await up.close();
  });
  const post = (token: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    b.app.inject({ method: 'POST', url: '/agent/v1/chat/completions', headers: { authorization: `Bearer ${token}`, ...headers }, payload });
  const slotActive = (key: string) => b.agentFairness.snapshot().perClient.find((c) => c.clientId === key)?.active ?? 0;

  const openUpload = async (token: string) => {
    await b.app.listen({ port: 0, host: '127.0.0.1' });
    const sock = connect((b.app.server.address() as AddressInfo).port, '127.0.0.1');
    await new Promise<void>((r) => sock.once('connect', () => r()));
    sock.on('error', () => undefined);
    sock.write(`POST /agent/v1/chat/completions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${token}\r\n` +
      'Content-Type: application/json\r\nContent-Length: 100000\r\n\r\n{"messages":');
    return sock;
  };

  it('client dropping the connection mid-body frees the admission slot at once', async () => {
    const s = await start();
    const sock = await openUpload(s.token);
    const key = `emp:${s.employeeId}`;
    await waitFor(() => slotActive(key) === 1);
    sock.destroy();
    await waitFor(() => slotActive(key) === 0);
    expect(b.agentFairness.snapshot().globalActive).toBe(0);
  });

  it('a body that does not arrive in time closes the connection and frees the slot', async () => {
    const s = await start({ AGENT_BODY_READ_TIMEOUT_MS: 300 });
    const sock = await openUpload(s.token);
    const closed = new Promise<void>((r) => sock.once('close', () => r()));
    const key = `emp:${s.employeeId}`;
    await waitFor(() => slotActive(key) === 1);
    await closed;
    expect(slotActive(key)).toBe(0);
  });

  it('parallel requests with the same X-Request-Id are two live requests, unsafe ids are replaced', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    handler = (_q, res) => void gate.then(() => jsonResponse(res, 200, chatSuccessBody('ok')));
    const s = await start();
    const p = [post(s.token, { messages: msgs }, { 'x-request-id': 'same-id' }), post(s.token, { messages: msgs }, { 'x-request-id': 'same-id' })];
    await waitFor(() => b.agentActiveMetrics.size() === 2);
    expect(b.agentActiveMetrics.countAdmittedTotal()).toBe(2);
    release();
    expect((await Promise.all(p)).map((r) => r.statusCode)).toEqual([200, 200]);
    const bad = await post(s.token, { messages: msgs }, { 'x-request-id': 'bad id <x>' });
    expect(bad.headers['x-proxy-request-id']).not.toBe('bad id <x>');
  });

  it('strips cost-multiplying fields and caps output tokens', async () => {
    handler = (_q, res) => jsonResponse(res, 200, chatSuccessBody());
    const s = await start({ AGENT_MAX_OUTPUT_TOKENS: 1000 });
    const r = await post(s.token, {
      messages: msgs, n: 8, store: true, service_tier: 'priority', web_search_options: {},
      max_tokens: 50_000, max_completion_tokens: 20, reasoning: { max_tokens: 9999, effort: 'high' },
    });
    expect(r.statusCode).toBe(200);
    // Мок сам вычитывает тело и складывает его в requests.
    const sent = JSON.parse(up.requests.at(-1)!.body) as Record<string, unknown>;
    for (const k of ['n', 'store', 'service_tier', 'web_search_options']) expect(sent).not.toHaveProperty(k);
    expect(sent).toMatchObject({ max_tokens: 1000, max_completion_tokens: 20, reasoning: { max_tokens: 1000, effort: 'high' } });
  });

  it('network error details stay in the journal, not in the answer', async () => {
    const port = await freePort();
    const s = await start({ AGENT_UPSTREAM_MAX_ATTEMPTS: 1 }, { baseUrl: `http://127.0.0.1:${port}/v1` });
    const r = await post(s.token, { messages: msgs });
    expect(r.statusCode).toBeGreaterThanOrEqual(500);
    expect(r.json().error.message).toBe('the connection to the provider failed');
    expect(r.body).not.toContain(String(port));
  }, 15_000);

  it('non-JSON provider errors are replaced and echoed provider secrets are redacted', async () => {
    let n = 0;
    handler = (_q, res) => {
      n += 1;
      if (n === 1) {
        res.writeHead(502, { 'content-type': 'text/html' });
        res.end('<html>gateway 10.0.0.7 down</html>');
      } else {
        jsonResponse(res, 400, { error: { message: 'bad header value gw-secret-value-123', code: 'bad' } });
      }
    };
    const s = await start({ AGENT_UPSTREAM_MAX_ATTEMPTS: 1 });
    b.repos.providers.update(s.providerId, { extra_headers_enc: b.secrets.seal(JSON.stringify({ 'X-Gateway-Key': 'gw-secret-value-123' })) }, Date.now());
    b.agentRegistry.reload();
    const r1 = await post(s.token, { messages: msgs });
    expect(r1.statusCode).toBe(502);
    expect(r1.headers['content-type']).toContain('application/json');
    expect(r1.headers['x-content-type-options']).toBe('nosniff');
    expect(r1.body).not.toContain('10.0.0.7');
    const r2 = await post(s.token, { messages: msgs });
    expect(r2.statusCode).toBe(400);
    expect(r2.body).not.toContain('gw-secret-value-123');
    expect(r2.body).toContain('[REDACTED]');
  });

  it('revoking a key cuts its live stream', async () => {
    handler = (_q, res) => void sseResponse(res, ['a', 'b', 'c', 'd', 'e'].map((t) => chatChunk(t)), { delayMs: 250 });
    const s = await start();
    const p = post(s.token, { stream: true, messages: msgs });
    await waitFor(() => b.agentActiveMetrics.size() === 1);
    await new Promise((r) => setTimeout(r, 450));
    b.repos.agentTokens.revoke(s.tokenId, Date.now());
    b.agentRegistry.reload();
    const r = await p;
    expect(r.body).toContain('key_revoked');
    expect(r.body).not.toContain('"e"');
    const row = b.db.db.prepare('SELECT error_code FROM requests ORDER BY id DESC LIMIT 1').get();
    expect(row).toMatchObject({ error_code: 'key_revoked' });
  });
});

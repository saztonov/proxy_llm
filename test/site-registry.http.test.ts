import { describe, expect, it, afterEach } from 'vitest';
import { buildApp, type AppBundle } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, chatSuccessBody, type MockServer } from './helpers/mock-openrouter.js';
import { generateToken, sha256Hex } from '../src/clients/tokens.js';

const LEGACY = 'legacy-token-1234567890';
const payload = { messages: [{ role: 'user', content: 'hi' }] };

async function close(b: AppBundle): Promise<void> {
  await b.app.close();
  b.db.close();
  b.stopWatchdog();
  b.stopDigest();
  b.stopFairnessReconciler();
  b.stopPriceSync();
}

describe('site registry over HTTP', () => {
  let upstream: MockServer | undefined;
  let bundles: AppBundle[] = [];
  afterEach(async () => {
    for (const b of bundles) await close(b).catch(() => {});
    bundles = [];
    await upstream?.close();
  });

  const post = (b: AppBundle, token: string) =>
    b.app.inject({ method: 'POST', url: '/api/v1/chat/completions', headers: { authorization: `Bearer ${token}` }, payload });

  it('issued token works at once; revocation applies without restart and survives it', async () => {
    upstream = await startMockOpenRouter((_req, res) => jsonResponse(res, 200, chatSuccessBody()));
    const config = makeTestConfig({ OPENROUTER_BASE_URL: upstream.baseUrl, PROXY_INBOUND_TOKEN: LEGACY });
    const b = await buildApp(config);
    bundles.push(b);
    expect((await post(b, LEGACY)).statusCode).toBe(200);

    const t = generateToken('site');
    const id = b.repos.siteTokens.issue({ token_sha256: t.sha256, token_prefix: t.prefix, label: 'new', client_id: 'passdesk' }, Date.now());
    b.registry.reload();
    expect((await post(b, t.plaintext)).statusCode).toBe(200);
    expect(b.db.db.prepare('SELECT client_id, contour, token_id FROM requests ORDER BY id DESC LIMIT 1').get())
      .toEqual({ client_id: 'passdesk', contour: 'site', token_id: id });
    expect(b.db.db.prepare('SELECT contour, token_id FROM billing_attempts ORDER BY id DESC LIMIT 1').get())
      .toEqual({ contour: 'site', token_id: id });

    b.repos.siteTokens.revoke(b.repos.siteTokens.getByHash(sha256Hex(LEGACY))!.id, Date.now());
    b.registry.reload();
    expect((await post(b, LEGACY)).statusCode).toBe(401);

    await close(b);
    bundles = [];
    const again = await buildApp(config);
    bundles.push(again);
    expect((await post(again, LEGACY)).statusCode).toBe(401);
    expect((await post(again, t.plaintext)).statusCode).toBe(200);
  });

  it('limit change reaches fairness without restart', async () => {
    const b = await buildApp(makeTestConfig());
    bundles.push(b);
    b.repos.siteClients.update('passdesk', { max_concurrency: 5, max_pending: 7 }, Date.now());
    b.registry.reload();
    expect(b.fairness.snapshot().perClient.find((p) => p.clientId === 'passdesk'))
      .toMatchObject({ maxConcurrency: 5, maxPending: 7 });
  });
});

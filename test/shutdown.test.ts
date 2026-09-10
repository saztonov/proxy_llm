import { describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { request } from 'undici';
import { buildApp } from '../src/app.js';
import { gracefulShutdown } from '../src/shutdown.js';
import { openDb } from '../src/storage/db.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter } from './helpers/mock-openrouter.js';
import { capturingLogger } from './helpers/silent-logger.js';

describe('graceful shutdown', () => {
  it('aborts a hanging request after drainMs, journals it, then closes the DB', async () => {
    const up = await startMockOpenRouter(() => {
      /* провайдер завис и не отвечает */
    });
    const config = makeTestConfig({ OPENROUTER_BASE_URL: up.baseUrl, UPSTREAM_ATTEMPT_TIMEOUT_MS: 4000, REQUEST_DEADLINE_MS: 8000 });
    const bundle = await buildApp(config);
    await bundle.app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = bundle.app.server.address() as AddressInfo;

    const pending = request(`http://127.0.0.1:${port}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.PROXY_INBOUND_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    await vi.waitFor(() => expect(bundle.activeMetrics.size()).toBe(1), { timeout: 3000 });

    const t0 = Date.now();
    await gracefulShutdown(bundle, { drainMs: 300, closeGraceMs: 3000, settleMs: 1000, logger: capturingLogger().logger });
    expect(Date.now() - t0).toBeLessThan(3000);

    const res = await pending;
    expect(res.statusCode).toBe(504);
    await res.body.text();

    const db = openDb(config.DB_PATH);
    expect(db.db.prepare('SELECT status, error_code FROM requests').get()).toEqual({ status: 'timeout', error_code: 'aborted' });
    db.close();
    await up.close();
  });
});

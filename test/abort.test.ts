import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { OpenRouterClient } from '../src/upstream/openrouter-client.js';
import { logger } from '../src/utils/logger.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, type MockServer } from './helpers/mock-openrouter.js';

describe('external abort reaches upstream', () => {
  let upstream: MockServer;

  beforeAll(async () => {
    // Мок, который НИКОГДА не отвечает — имитирует зависший upstream.
    upstream = await startMockOpenRouter(async () => {
      await new Promise(() => {}); // never resolves
    });
  });

  afterAll(async () => {
    await upstream.close();
  });

  it('aborting the external signal cancels the request well before the attempt timeout', async () => {
    const config = makeTestConfig({
      OPENROUTER_BASE_URL: upstream.baseUrl,
      UPSTREAM_MAX_ATTEMPTS: 1,
      UPSTREAM_ATTEMPT_TIMEOUT_MS: 8000, // большой — если abort не сработает, тест повиснет к нему
      REQUEST_DEADLINE_MS: 20_000,
      MIN_REMAINING_MS: 200,
    });
    const client = new OpenRouterClient(config, logger);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200).unref();

    const started = Date.now();
    const result = await client.execute({
      incoming: { messages: [{ role: 'user', content: 'hang' }] },
      requestId: 'abort-1',
      modelResolution: { model: 'mock/model', fallbackModels: [] },
      signal: ac.signal,
    });
    const elapsed = Date.now() - started;

    expect(result.statusCode).toBe(504);
    expect(result.classification).toBe('network_error');
    // Если бы внешний abort НЕ доходил до undici — ждали бы ~8000ms attempt timeout.
    expect(elapsed).toBeLessThan(3000);
  });
});

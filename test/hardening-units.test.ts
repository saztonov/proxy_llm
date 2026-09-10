import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { makeTestConfig } from './helpers/test-config.js';
import { startMockOpenRouter, jsonResponse, chatSuccessBody } from './helpers/mock-openrouter.js';
import { AuthFailureMonitor } from '../src/agent/limiters.js';
import { validateExtraHeader } from '../src/upstream/provider-headers.js';
import { validateProviderUrl } from '../src/upstream/provider-url.js';
import { buildAgentPayload } from '../src/upstream/agent-payload.js';
import { isSafeRequestId } from '../src/utils/ids.js';
import { intOption, CliError } from '../src/cli/admin.js';
import { openDb } from '../src/storage/db.js';
import { createRepos } from '../src/storage/repos.js';
import { startRegistryWatcher } from '../src/clients/registry-watcher.js';
import type { Logger } from '../src/utils/logger.js';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('hardening units', () => {
  it('auth failure log lines come in bursts, skipped ones are counted', () => {
    let now = 0;
    const m = new AuthFailureMonitor(300_000, () => now);
    const logged = Array.from({ length: AuthFailureMonitor.LOG_BURST + 5 }, () => m.logDecision()).filter((d) => d.log);
    expect(logged).toHaveLength(AuthFailureMonitor.LOG_BURST);
    now += AuthFailureMonitor.LOG_WINDOW_MS;
    expect(m.logDecision()).toEqual({ log: true, suppressed: 5 });
  });

  it('proxy-chain and hop headers cannot be set as provider extra headers', () => {
    for (const h of ['Expect', 'Content-Encoding', 'Forwarded', 'X-Forwarded-For', 'X-Real-IP', 'Proxy-Anything']) {
      expect(validateExtraHeader(h, 'v')).not.toBeNull();
    }
    expect(validateExtraHeader('X-Gateway-Key', 'v')).toBeNull();
  });

  it('provider URL can never point at link-local or unspecified addresses', () => {
    for (const u of ['https://169.254.169.254/v1', 'https://[::ffff:169.254.169.254]/v1', 'https://0.0.0.0/v1', 'https://[fe80::1]/v1']) {
      expect(validateProviderUrl(u, true)).not.toBeNull();
    }
    expect(validateProviderUrl('https://api.example.com/v1', false)).toBeNull();
  });

  it('payload cap is off at 0 and never raises a smaller max_tokens', () => {
    const base = { messages: [], max_tokens: 100_000 };
    expect(buildAgentPayload(base, { model: 'm', usageMode: 'none', maxOutputTokens: 0 }).payload.max_tokens).toBe(100_000);
    expect(buildAgentPayload({ ...base, max_tokens: 10 }, { model: 'm', usageMode: 'none', maxOutputTokens: 500 }).payload.max_tokens).toBe(10);
  });

  it('safe request id accepts ids, rejects spaces and markup', () => {
    expect(isSafeRequestId('3f2a-uuid_1.2:x')).toBe(true);
    expect(isSafeRequestId('a b')).toBe(false);
    expect(isSafeRequestId('<x>')).toBe(false);
    expect(isSafeRequestId('x'.repeat(129))).toBe(false);
  });

  it('CLI numeric options fail loudly instead of becoming NaN', () => {
    expect(intOption(undefined, 'expires-days', 1, 3650)).toBeNull();
    expect(intOption('30', 'expires-days', 1, 3650)).toBe(30);
    for (const bad of ['abc', '-5', '0', '1.5', '99999']) expect(() => intOption(bad, 'expires-days', 1, 3650)).toThrow(CliError);
  });

  it('registry watcher reloads once per CLI generation bump', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proxy_llm-watch-'));
    const handle = openDb(join(dir, 't.db'));
    try {
      const repos = createRepos(handle.db);
      let reloads = 0;
      const stop = startRegistryWatcher({ settings: repos.settings, reload: () => { reloads += 1; }, intervalMs: 20, logger: quiet });
      await sleep(80);
      expect(reloads).toBe(0);
      repos.settings.bumpRegistryGeneration(Date.now());
      await sleep(120);
      expect(reloads).toBe(1);
      stop();
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('site contour: parallel requests with the same X-Request-Id stay two live requests', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const up = await startMockOpenRouter((_q, res) => void gate.then(() => jsonResponse(res, 200, chatSuccessBody())));
    const b = await buildApp(makeTestConfig({ OPENROUTER_BASE_URL: up.baseUrl }));
    try {
      const token = makeTestConfig().PROXY_INBOUND_TOKEN!;
      const send = () => b.app.inject({
        method: 'POST', url: '/api/v1/chat/completions',
        headers: { authorization: `Bearer ${token}`, 'x-request-id': 'dup-1' },
        payload: { messages: [{ role: 'user', content: 'hi' }] },
      });
      const p = [send(), send()];
      for (let i = 0; i < 200 && b.activeMetrics.size() < 2; i++) await sleep(20);
      expect(b.activeMetrics.size()).toBe(2);
      expect(b.activeMetrics.countAdmittedTotal()).toBe(2);
      release();
      expect((await Promise.all(p)).map((r) => r.statusCode)).toEqual([200, 200]);
      expect(b.fairness.snapshot().globalActive).toBe(0);
    } finally {
      await b.app.close();
      b.db.close();
      b.stopTickers();
      await up.close();
    }
  });
});

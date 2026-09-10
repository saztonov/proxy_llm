import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AlertEngine, type ObservedEvent } from '../src/alerts/rules.js';
import type { TelegramSender } from '../src/alerts/telegram.js';
import { openDb, type DbHandle } from '../src/storage/db.js';
import { RequestsRepo, type RequestStatus } from '../src/storage/requests-repo.js';
import { makeTestConfig } from './helpers/test-config.js';
import { capturingLogger } from './helpers/silent-logger.js';
import { requestRecord } from './helpers/records.js';

describe('alerts per contour', () => {
  let dir: string;
  let handle: DbHandle;
  let repo: RequestsRepo;
  let sent: string[];
  let engine: AlertEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proxy_llm-ac-'));
    handle = openDb(join(dir, 't.db'));
    repo = new RequestsRepo(handle.db);
    sent = [];
    const telegram = { send: async (t: string) => void sent.push(t), enabled: () => true } as unknown as TelegramSender;
    const config = makeTestConfig({
      ALERT_ERROR_RATE_WINDOW: 20,
      ALERT_ERROR_RATE_THRESHOLD: 0.3,
      ALERT_ERROR_STREAK_THRESHOLD: 1000,
      ALERT_LONG_REQUEST_MS: 150_000,
    });
    engine = new AlertEngine(config, telegram, repo, capturingLogger().logger);
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const fill = (n: number, status: RequestStatus, contour: 'site' | 'agent'): void => {
    for (let i = 0; i < n; i++) repo.insert(requestRecord({ status, contour }));
  };
  const ev = (e: Partial<ObservedEvent>): ObservedEvent => ({
    type: 'request_completed', status: 'success', httpStatus: 200, latencyMs: 10, errorCode: null, ...e,
  });

  it('agent errors raise an agent error-rate alert and leave sites alone', async () => {
    fill(20, 'success', 'site');
    fill(20, 'upstream_error', 'agent');
    await engine.onEvent(ev({ contour: 'site' }));
    expect(sent).toEqual([]);
    await engine.onEvent(ev({ contour: 'agent', status: 'upstream_error', httpStatus: 500 }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('(агенты)');
  });

  it('user cancellations are not errors', async () => {
    fill(5, 'upstream_error', 'agent');
    fill(25, 'client_aborted', 'agent');
    await engine.onEvent(ev({ contour: 'agent', status: 'client_aborted' }));
    expect(sent).toEqual([]);
  });

  it('long-request threshold is per contour', async () => {
    await engine.onEvent(ev({ contour: 'agent', latencyMs: 200_000, longRequestThresholdMs: 540_000 }));
    expect(sent).toEqual([]);
    await engine.onEvent(ev({ contour: 'site', latencyMs: 200_000 }));
    expect(sent.some((t) => t.includes('Долгий'))).toBe(true);
  });

  it('401 names the provider and escapes it for Telegram HTML', async () => {
    await engine.onEvent(ev({ contour: 'agent', status: 'upstream_error', httpStatus: 401, errorCode: '401', upstreamLabel: 'Deep<Seek>' }));
    expect(sent[0]).toContain('Deep&lt;Seek&gt; 401');
    await engine.onEvent(ev({ status: 'upstream_error', httpStatus: 401, errorCode: '401' }));
    expect(sent[1]).toContain('OPENROUTER_API_KEY');
  });

  it('daily digest keeps site numbers and adds an agent block', async () => {
    fill(3, 'success', 'site');
    fill(2, 'success', 'agent');
    fill(1, 'client_aborted', 'agent');
    fill(1, 'stream_incomplete', 'agent');
    await engine.sendDailyDigest();
    expect(sent[0]).toContain('Запросов: 3 (успешных: 3, ошибок: 0)');
    expect(sent[0]).toContain('🤖 Агенты');
    expect(sent[0]).toContain('Запросов: 4 (успешных: 2, ошибок: 1, отменено: 1)');
  });
});

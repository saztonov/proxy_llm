import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../src/config.js';

export function makeTestConfig(overrides: Partial<Config> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'proxy_llm-test-'));
  return {
    LISTEN_HOST: '127.0.0.1',
    LISTEN_PORT: 0,
    PROXY_INBOUND_TOKEN: 'test-token-1234567890abcdef',
    BODY_LIMIT_BYTES: 27_262_976,

    OPENROUTER_API_KEY: 'sk-or-test-key',
    OPENROUTER_BASE_URL: 'http://127.0.0.1:9',
    OPENROUTER_MODEL: 'mock/model',
    OPENROUTER_FALLBACK_MODELS: [],
    OPENROUTER_HTTP_REFERER: 'https://test.example',
    OPENROUTER_X_TITLE: 'test',

    REQUEST_DEADLINE_MS: 5000,
    UPSTREAM_ATTEMPT_TIMEOUT_MS: 2000,
    UPSTREAM_MAX_ATTEMPTS: 2,
    MIN_REMAINING_MS: 200,
    UPSTREAM_RESPONSE_BODY_LIMIT_BYTES: 2_097_152,

    QUEUE_CONCURRENCY: 4,
    QUEUE_MAX_PENDING: 100,
    MAX_ACTIVE_DEDUP_KEYS: 100,
    GRACEFUL_DRAIN_MS: 1000,

    DB_PATH: join(dir, 'test.db'),

    DASHBOARD_USER: 'admin',
    DASHBOARD_BASIC_AUTH_PASS: 'test-pass',

    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_ADMIN_CHAT_ID: '',

    ALERT_ERROR_STREAK_THRESHOLD: 5,
    ALERT_ERROR_RATE_THRESHOLD: 0.3,
    ALERT_ERROR_RATE_WINDOW: 50,
    ALERT_LONG_REQUEST_MS: 150_000,
    ALERT_DISK_FREE_MIN_BYTES: 524_288_000,

    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    PROXY_SKIP_DB_INIT: false,
    ...overrides,
  } as Config;
}

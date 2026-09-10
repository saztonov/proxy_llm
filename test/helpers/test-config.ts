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

    CLIENTS_CONFIG_PATH: undefined,
    CLIENT_DEFAULT_MAX_CONCURRENCY: 2,
    CLIENT_DEFAULT_MAX_PENDING: 10,
    CLIENT_DEFAULT_ALLOWED_MODELS: [],

    DB_PATH: join(dir, 'test.db'),

    // Фиксируем зону явно: иначе billing_day считался бы по системной зоне машины и тесты
    // границ суток были бы недетерминированными.
    BILLING_TIMEZONE: 'Europe/Moscow',
    // Выключено по умолчанию: иначе демон при buildApp сходит на мок-сервер за каталогом
    // моделей и сломает ассерты «апстрим вызван N раз» в существующих тестах.
    BILLING_PRICE_SYNC_ENABLED: false,
    BILLING_PRICE_SYNC_HOUR: 6,
    BILLING_PRICE_SYNC_TIMEOUT_MS: 20_000,
    BILLING_PRICE_BODY_LIMIT_BYTES: 8_388_608,

    DASHBOARD_USER: 'admin',
    DASHBOARD_BASIC_AUTH_PASS: 'test-pass',

    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_ADMIN_CHAT_ID: '',

    ALERT_ERROR_STREAK_THRESHOLD: 5,
    ALERT_ERROR_RATE_THRESHOLD: 0.3,
    ALERT_ERROR_RATE_WINDOW: 50,
    ALERT_LONG_REQUEST_MS: 150_000,
    ALERT_DISK_FREE_MIN_BYTES: 524_288_000,

    SECRETS_ENCRYPTION_KEY: 'test-secrets-key-0123456789abcdef0123456789abcdef',

    ADMIN_JWT_SECRET: 'test-admin-jwt-secret-0123456789abcdef0123456789',
    ADMIN_COOKIE_SECURE: false,
    ADMIN_ACCESS_TTL_SEC: 900,
    ADMIN_REFRESH_TTL_SEC: 1_209_600,
    ADMIN_SESSION_ABSOLUTE_TTL_SEC: 2_592_000,
    ADMIN_REFRESH_REUSE_GRACE_SEC: 0,
    ADMIN_LOGIN_MAX_ATTEMPTS: 5,
    ADMIN_LOGIN_WINDOW_SEC: 900,
    // Высокий per-IP лимит: иначе хелперы логина в одном app упирались бы в него.
    ADMIN_LOGIN_IP_MAX: 1000,
    ADMIN_PROVIDER_CHECK_TIMEOUT_MS: 2000,
    // Мок-провайдеры живут на http://127.0.0.1.
    ADMIN_ALLOW_INSECURE_PROVIDERS: true,

    AGENT_QUEUE_CONCURRENCY: 32,
    AGENT_QUEUE_MAX_PENDING: 64,
    AGENT_PRINCIPAL_MAX_CONCURRENCY: 3,
    AGENT_PRINCIPAL_MAX_PENDING: 3,
    AGENT_RATE_LIMIT_MAX: 10_000,
    AGENT_RATE_LIMIT_WINDOW_MS: 60_000,
    AGENT_AUTH_FAIL_ALERT_THRESHOLD: 20,
    AGENT_UPSTREAM_POOL_CONNECTIONS: 64,
    AGENT_REQUEST_DEADLINE_MS: 8000,
    AGENT_UPSTREAM_ATTEMPT_TIMEOUT_MS: 5000,
    AGENT_UPSTREAM_HEADERS_TIMEOUT_MS: 3000,
    AGENT_STREAM_FIRST_EVENT_TIMEOUT_MS: 3000,
    AGENT_STREAM_IDLE_TIMEOUT_MS: 3000,
    AGENT_UPSTREAM_MAX_ATTEMPTS: 2,
    AGENT_MIN_REMAINING_MS: 200,
    AGENT_UPSTREAM_RESPONSE_BODY_LIMIT_BYTES: 8_388_608,
    AGENT_STREAM_RESPONSE_LIMIT_BYTES: 16_777_216,
    AGENT_BODY_LIMIT_BYTES: 1_048_576,
    AGENT_BODY_READ_TIMEOUT_MS: 2000,
    AGENT_MAX_OUTPUT_TOKENS: 32_768,
    AGENT_ALERT_LONG_REQUEST_MS: 540_000,
    AGENT_CORS_ALLOWED_ORIGINS: [],

    MEMORY_BUDGET_BYTES: 419_430_400,
    MEMORY_BUDGET_MODE: 'warn',

    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    ...overrides,
  } as Config;
}

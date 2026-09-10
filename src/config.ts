import { z } from 'zod';

const csvList = z
  .string()
  .default('')
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

const boolFromString = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

/** Как boolFromString, но по умолчанию включено: выключить можно только явным 'false'/'0'. */
const boolFromStringDefaultTrue = z
  .string()
  .optional()
  .transform((v) => v === undefined || !(v === 'false' || v === '0'));

/** Флаг без дефолта: undefined = «не задан», значение выводится ниже из контекста. */
const optionalBool = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v === 'true' || v === '1'));

const MiB = 1024 * 1024;

const baseSchema = z.object({
  // Inbound
  LISTEN_HOST: z.string().default('127.0.0.1'),
  LISTEN_PORT: z.coerce.number().int().positive().default(3000),
  // Legacy single-tenant токен. При первом старте импортируется в БД как обычный токен клиента
  // passdesk (src/clients/site-bootstrap.ts) и дальше отзывается из админки; env можно убрать.
  PROXY_INBOUND_TOKEN: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(16, 'PROXY_INBOUND_TOKEN must be at least 16 chars').optional(),
  ),
  BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(27_262_976),

  // OpenRouter
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai'),
  OPENROUTER_MODEL: z.string().min(1),
  OPENROUTER_FALLBACK_MODELS: csvList,
  OPENROUTER_HTTP_REFERER: z.string().default(''),
  OPENROUTER_X_TITLE: z.string().default('proxy_llm'),

  // Deadlines / Retry
  REQUEST_DEADLINE_MS: z.coerce.number().int().positive().default(190_000),
  UPSTREAM_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().positive().default(160_000),
  UPSTREAM_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  MIN_REMAINING_MS: z.coerce.number().int().nonnegative().default(10_000),
  UPSTREAM_RESPONSE_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(2_097_152),

  // Queue / Dedup
  // QUEUE_CONCURRENCY — общий (global) потолок одновременных upstream-вызовов.
  // QUEUE_MAX_PENDING — общий потолок admitted-запросов (память/back-pressure).
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(1),
  QUEUE_MAX_PENDING: z.coerce.number().int().min(1).max(1000).default(10),
  MAX_ACTIVE_DEDUP_KEYS: z.coerce.number().int().min(1).max(100_000).default(1000),
  GRACEFUL_DRAIN_MS: z.coerce.number().int().nonnegative().default(60_000),

  // Multi-tenant: реестр клиентов + пер-клиентские дефолты.
  // Путь НЕ задан → single-tenant legacy из PROXY_INBOUND_TOKEN. Путь задан явно, но
  // файл отсутствует/битый → fail-fast (см. src/clients/registry.ts).
  CLIENTS_CONFIG_PATH: z.string().optional(),
  CLIENT_DEFAULT_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(1),
  CLIENT_DEFAULT_MAX_PENDING: z.coerce.number().int().min(1).max(1000).default(10),
  CLIENT_DEFAULT_ALLOWED_MODELS: csvList,

  // Storage
  DB_PATH: z.string().default('/var/lib/proxy_llm/prod.db'),

  // Billing.
  // BILLING_TIMEZONE — IANA-зона, в которой считаются биллинговые сутки. Вычисляется в TS и
  // пишется колонкой billing_day; в SQL никаких сдвигов, чтобы границы суток не разъезжались.
  BILLING_TIMEZONE: z.string().default('Europe/Moscow'),
  BILLING_PRICE_SYNC_ENABLED: boolFromStringDefaultTrue,
  BILLING_PRICE_SYNC_HOUR: z.coerce.number().int().min(0).max(23).default(6),
  BILLING_PRICE_SYNC_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  // Каталог моделей — 1-3 МБ, общий UPSTREAM_RESPONSE_BODY_LIMIT_BYTES (2 МБ) для него мал.
  BILLING_PRICE_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(8_388_608),

  // Dashboard
  DASHBOARD_USER: z.string().default('admin'),
  DASHBOARD_BASIC_AUTH_PASS: z.string().min(1),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_ADMIN_CHAT_ID: z.string().default(''),

  // Alerts
  ALERT_ERROR_STREAK_THRESHOLD: z.coerce.number().int().positive().default(5),
  ALERT_ERROR_RATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.3),
  ALERT_ERROR_RATE_WINDOW: z.coerce.number().int().positive().default(50),
  ALERT_LONG_REQUEST_MS: z.coerce.number().int().positive().default(360_000),
  ALERT_DISK_FREE_MIN_BYTES: z.coerce.number().int().nonnegative().default(524_288_000),

  // Secrets. Шифрует API-ключи провайдеров и сайтов в SQLite (AES-256-GCM, storage/secret-box.ts).
  // Без этого ключа зашифрованные значения из БД не прочитать: бэкапить вместе с БД, храня отдельно.
  SECRETS_ENCRYPTION_KEY: z
    .string()
    .min(32, 'SECRETS_ENCRYPTION_KEY must be at least 32 chars (openssl rand -hex 32)'),

  // Admin site (/admin). Из ADMIN_JWT_SECRET через HKDF выводятся ключи подписи JWT и CSRF.
  ADMIN_JWT_SECRET: z
    .string()
    .min(32, 'ADMIN_JWT_SECRET must be at least 32 chars (openssl rand -hex 32)'),
  // Secure-флаг cookie. Не задан → включён при NODE_ENV=production.
  ADMIN_COOKIE_SECURE: optionalBool,
  ADMIN_ACCESS_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(900),
  ADMIN_REFRESH_TTL_SEC: z.coerce.number().int().min(300).default(14 * 86_400),
  ADMIN_SESSION_ABSOLUTE_TTL_SEC: z.coerce.number().int().min(300).default(30 * 86_400),
  // Окно, в котором повторное предъявление уже ротированного refresh считается гонкой двух
  // вкладок (409), а не кражей (отзыв всей сессии).
  ADMIN_REFRESH_REUSE_GRACE_SEC: z.coerce.number().int().min(0).max(300).default(30),
  ADMIN_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
  ADMIN_LOGIN_WINDOW_SEC: z.coerce.number().int().positive().default(900),
  ADMIN_LOGIN_IP_MAX: z.coerce.number().int().min(1).default(10),
  ADMIN_PROVIDER_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Разрешить провайдеров по http:// на loopback/частных адресах (локальная Ollama).
  // Публичный http:// не разрешается никогда.
  ADMIN_ALLOW_INSECURE_PROVIDERS: boolFromString,

  // Agent contour (/agent/v1) — OpenAI API для AI-агентов сотрудников.
  // AGENT_QUEUE_CONCURRENCY — одновременных upstream-вызовов (стримов);
  // AGENT_QUEUE_MAX_PENDING — всего принятых запросов (в работе + в ожидании).
  // AGENT_PRINCIPAL_* — дефолтные лимиты сотрудника/отдела (переопределяются в справочнике).
  AGENT_QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(200).default(32),
  AGENT_QUEUE_MAX_PENDING: z.coerce.number().int().min(1).max(2000).default(64),
  AGENT_PRINCIPAL_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(3),
  AGENT_PRINCIPAL_MAX_PENDING: z.coerce.number().int().min(1).max(100).default(3),
  AGENT_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(240),
  AGENT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  AGENT_AUTH_FAIL_ALERT_THRESHOLD: z.coerce.number().int().min(1).default(20),
  AGENT_UPSTREAM_POOL_CONNECTIONS: z.coerce.number().int().min(1).max(500).default(40),
  AGENT_REQUEST_DEADLINE_MS: z.coerce.number().int().positive().default(600_000),
  AGENT_UPSTREAM_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  // Стрим: до заголовков ответа / до первого data-события / тишина между чанками.
  AGENT_UPSTREAM_HEADERS_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  AGENT_STREAM_FIRST_EVENT_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  AGENT_STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  AGENT_UPSTREAM_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  AGENT_MIN_REMAINING_MS: z.coerce.number().int().nonnegative().default(5_000),
  AGENT_UPSTREAM_RESPONSE_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(8 * MiB),
  AGENT_STREAM_RESPONSE_LIMIT_BYTES: z.coerce.number().int().positive().default(16 * MiB),
  AGENT_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1 * MiB),
  AGENT_ALERT_LONG_REQUEST_MS: z.coerce.number().int().positive().default(540_000),
  AGENT_CORS_ALLOWED_ORIGINS: csvList,

  // Бюджет памяти на тела запросов в очередях обоих контуров (см. estimateMemoryBudget).
  MEMORY_BUDGET_BYTES: z.coerce.number().int().positive().default(400 * MiB),
  MEMORY_BUDGET_MODE: z.enum(['warn', 'fail']).default('warn'),

  // Misc
  LOG_LEVEL: z.string().default('info'),
  NODE_ENV: z.string().default('production'),
});

const schema = baseSchema.transform((c) => ({
  ...c,
  ADMIN_COOKIE_SECURE: c.ADMIN_COOKIE_SECURE ?? c.NODE_ENV === 'production',
}));

export type Config = z.infer<typeof schema>;

export interface MemoryBudget {
  estimatedBytes: number;
  budgetBytes: number;
  ok: boolean;
}

/**
 * Грубая оценка пикового расхода памяти на тела запросов, принятых в очереди.
 *
 * Изоляция очередей контуров не изолирует память: это один процесс с одним MemoryMax, и
 * переполнение роняет оба контура разом. Сайты: сырое тело (base64-сканы, до BODY_LIMIT_BYTES).
 * Агенты: сырое тело + распарсенный объект (×2). Плюс два параллельных scrypt админ-логина.
 */
export function estimateMemoryBudget(c: Config): MemoryBudget {
  const sites = c.QUEUE_MAX_PENDING * c.BODY_LIMIT_BYTES;
  const agents = c.AGENT_QUEUE_MAX_PENDING * c.AGENT_BODY_LIMIT_BYTES * 2;
  const scrypt = 2 * 32 * MiB;
  const estimatedBytes = sites + agents + scrypt;
  return { estimatedBytes, budgetBytes: c.MEMORY_BUDGET_BYTES, ok: estimatedBytes <= c.MEMORY_BUDGET_BYTES };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('\n  ');
    throw new Error(`Config validation failed:\n  ${issues}`);
  }
  if (
    parsed.data.REQUEST_DEADLINE_MS <
    parsed.data.UPSTREAM_ATTEMPT_TIMEOUT_MS + parsed.data.MIN_REMAINING_MS
  ) {
    throw new Error(
      'REQUEST_DEADLINE_MS must be >= UPSTREAM_ATTEMPT_TIMEOUT_MS + MIN_REMAINING_MS',
    );
  }
  const c = parsed.data;
  if (c.AGENT_REQUEST_DEADLINE_MS < c.AGENT_UPSTREAM_ATTEMPT_TIMEOUT_MS + c.AGENT_MIN_REMAINING_MS) {
    throw new Error(
      'AGENT_REQUEST_DEADLINE_MS must be >= AGENT_UPSTREAM_ATTEMPT_TIMEOUT_MS + AGENT_MIN_REMAINING_MS',
    );
  }
  const mem = estimateMemoryBudget(c);
  if (!mem.ok && c.MEMORY_BUDGET_MODE === 'fail') {
    const mb = (b: number): string => `${Math.round(b / MiB)} MiB`;
    throw new Error(
      `memory budget exceeded: estimated ${mb(mem.estimatedBytes)} > MEMORY_BUDGET_BYTES ${mb(mem.budgetBytes)}; ` +
        'reduce QUEUE_MAX_PENDING/BODY_LIMIT_BYTES/AGENT_QUEUE_MAX_PENDING/AGENT_BODY_LIMIT_BYTES',
    );
  }
  return c;
}

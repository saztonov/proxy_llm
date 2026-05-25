import { z } from 'zod';

const csvList = z
  .string()
  .default('')
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

const boolFromString = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  // Inbound
  LISTEN_HOST: z.string().default('127.0.0.1'),
  LISTEN_PORT: z.coerce.number().int().positive().default(3000),
  PROXY_INBOUND_TOKEN: z.string().min(16, 'PROXY_INBOUND_TOKEN must be at least 16 chars'),
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
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(1),
  QUEUE_MAX_PENDING: z.coerce.number().int().min(1).max(1000).default(10),
  MAX_ACTIVE_DEDUP_KEYS: z.coerce.number().int().min(1).max(100_000).default(1000),
  GRACEFUL_DRAIN_MS: z.coerce.number().int().nonnegative().default(60_000),

  // Storage
  DB_PATH: z.string().default('/var/lib/proxy_llm/prod.db'),

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
  ALERT_LONG_REQUEST_MS: z.coerce.number().int().positive().default(150_000),
  ALERT_DISK_FREE_MIN_BYTES: z.coerce.number().int().nonnegative().default(524_288_000),

  // Misc
  LOG_LEVEL: z.string().default('info'),
  NODE_ENV: z.string().default('production'),
  PROXY_SKIP_DB_INIT: boolFromString,
});

export type Config = z.infer<typeof schema>;

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
  return parsed.data;
}

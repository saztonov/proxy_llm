import { pino } from 'pino';

const SECRET_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-idempotency-key"]',
  'res.headers.authorization',
  'upstream.headers.authorization',
  '*.api_key',
  '*.apiKey',
  '*.token',
  'req.body',
  'res.body',
  'upstream.requestBody',
  'upstream.responseBody',
  'err.config',
  'err.request',
  'err.response.config',
  'err.response.data',
  // Админка и агентский контур: пароли, выданные токены, cookie, CSRF, секретные заголовки.
  '*.password',
  '*.plaintext',
  '*.refresh',
  '*.extraHeaders',
  // fast-redact раскрывает '*' только на один уровень — секреты глубже перечисляем явно.
  '*.*.apiKey',
  '*.*.api_key',
  '*.*.extraHeaders',
  'req.headers.cookie',
  '*.headers.cookie',
  '*["x-csrf-token"]',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: SECRET_REDACT_PATHS,
    censor: '[REDACTED]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export type Logger = typeof logger;

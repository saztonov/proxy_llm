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

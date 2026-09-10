import type { FastifyInstance } from 'fastify';
import { newRequestId, isSafeRequestId } from '../utils/ids.js';
import { ipAllowed } from '../utils/cidr.js';
import { sanitizeErrorForLog } from '../utils/sanitize-error.js';
import type { AgentPrincipal } from '../clients/agent-registry.js';
import { sendOpenAIError } from './errors.js';
import { WindowRateLimiter, ProviderLimiter, AuthFailureMonitor } from './limiters.js';
import { releaseAgentAdmission, clearBodyTimer, type AgentDeps } from './deps.js';
import { handleAgentChat } from './chat-handler.js';

export interface AgentPluginOptions {
  deps: AgentDeps;
}

const AUTH_FAILURE_WINDOW_MS = 5 * 60_000;
/** SDK требуют числовое поле created у модели; смысла у него здесь нет. */
const MODEL_CREATED = 1_735_689_600;

function modelList(p: AgentPrincipal): Array<Record<string, unknown>> {
  const t = p.target;
  if (!t) return [];
  return [
    { id: t.model, object: 'model', created: MODEL_CREATED, owned_by: t.provider.name },
    // Стабильный алиас: админ меняет модель токена, конфиги IDE у сотрудников не ломаются.
    { id: 'default', object: 'model', created: MODEL_CREATED, owned_by: 'proxy_llm' },
  ];
}

/**
 * Агентский контур: OpenAI-совместимый API для IDE и агентов сотрудников (Cursor, Continue,
 * Cline, OpenAI SDK). Инкапсулированный плагин с префиксом /agent/v1: свои хуки, формат ошибок
 * и лимиты; контур сайтов (/api/v1, /v1) он не затрагивает.
 *
 * Запросы Cursor идут с его облачных серверов, поэтому IP-allowlist здесь невозможен: защита —
 * 128-битный токен, лимиты на владельца токена и алерт на всплеск неверных токенов.
 */
export async function agentPlugin(app: FastifyInstance, opts: AgentPluginOptions): Promise<void> {
  const { deps } = opts;
  const { config, logger } = deps;
  const rateLimiter = new WindowRateLimiter(config.AGENT_RATE_LIMIT_MAX, config.AGENT_RATE_LIMIT_WINDOW_MS);
  const providerLimiter = new ProviderLimiter();
  const authFailures = new AuthFailureMonitor(AUTH_FAILURE_WINDOW_MS);
  const corsOrigins = new Set(config.AGENT_CORS_ALLOWED_ORIGINS);
  const chatRoute = `${app.prefix}/chat/completions`;

  app.setErrorHandler((err, req, reply) => {
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 413) {
      sendOpenAIError(reply, 413, 'payload_too_large', `Request body exceeds ${config.AGENT_BODY_LIMIT_BYTES} bytes.`);
    } else if (e.statusCode === 415) {
      sendOpenAIError(reply, 415, 'unsupported_media_type', 'Use Content-Type: application/json.');
    } else if (e.statusCode !== undefined && e.statusCode >= 400 && e.statusCode < 500) {
      sendOpenAIError(reply, e.statusCode, 'invalid_request', e.message ?? 'Bad request.');
    } else {
      logger.error({ err: sanitizeErrorForLog(err), requestId: req.agentContext?.requestId }, 'agent route error');
      sendOpenAIError(reply, 500, 'internal_error', 'Internal proxy error.');
    }
  });

  app.setNotFoundHandler((req, reply) => {
    sendOpenAIError(reply, 404, 'unknown_endpoint',
      `${req.method} ${req.url.split('?')[0]} is not supported. This API serves GET /models and POST /chat/completions.`);
  });

  if (corsOrigins.size > 0) {
    // Выключено по умолчанию: IDE и SDK ходят не из браузера. Включается списком origin.
    app.addHook('onRequest', async (req, reply) => {
      const origin = req.headers.origin;
      if (typeof origin !== 'string' || !corsOrigins.has(origin)) return;
      reply.header('access-control-allow-origin', origin).header('vary', 'Origin');
      if (req.method === 'OPTIONS') {
        reply
          .header('access-control-allow-methods', 'GET, POST, OPTIONS')
          .header('access-control-allow-headers', 'authorization, content-type, x-request-id')
          .header('access-control-max-age', '600')
          .code(204)
          .send();
      }
    });
  }

  app.addHook('onRequest', async (req, reply) => {
    if (reply.sent) return;
    const header = req.headers.authorization;
    const token = typeof header === 'string' && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '').trim() : '';
    const principal = token ? deps.registry.resolveToken(token) : null;
    if (!principal) {
      // Один ответ для отсутствующего, неизвестного, отозванного и истёкшего токена.
      const count = authFailures.record(req.ip);
      // Поток мусорных токенов не должен становиться потоком строк journald: не больше пачки
      // строк за окно, число пропущенных — в первой строке следующего окна.
      const log = authFailures.logDecision();
      if (log.log) {
        logger.warn({
          contour: 'agent', ip: req.ip, path: req.url.split('?')[0], reason: token ? 'invalid' : 'missing',
          ...(log.suppressed > 0 ? { suppressedBefore: log.suppressed } : {}),
        }, 'agent auth failed');
      }
      if (count >= config.AGENT_AUTH_FAIL_ALERT_THRESHOLD && authFailures.shouldNotify()) {
        deps.alerts.onAgentAuthFailures(count, AUTH_FAILURE_WINDOW_MS, authFailures.topIps()).catch(() => undefined);
      }
      sendOpenAIError(reply, 401, 'invalid_api_key', token ? 'Incorrect API key provided.' : 'Missing API key: use the Authorization: Bearer <key> header.');
      return;
    }
    if (principal.allowedCidrs && !ipAllowed(principal.allowedCidrs, req.ip)) {
      logger.warn({ contour: 'agent', ip: req.ip, tokenId: principal.tokenId }, 'agent key used from a disallowed network');
      sendOpenAIError(reply, 403, 'ip_not_allowed', 'This API key cannot be used from your network.');
      return;
    }

    const rawReqId = req.headers['x-request-id'];
    const requestId = typeof rawReqId === 'string' && isSafeRequestId(rawReqId) ? rawReqId : newRequestId();
    req.agentContext = { requestId, liveId: newRequestId(), tsReceived: Date.now(), principal, admitted: false, released: false };

    const rl = rateLimiter.hit(principal.slotKey);
    if (!rl.allowed) {
      reply.header('retry-after', String(rl.retryAfterSec));
      sendOpenAIError(reply, 429, 'rate_limit_exceeded',
        `Rate limit exceeded: ${config.AGENT_RATE_LIMIT_MAX} requests per ${Math.round(config.AGENT_RATE_LIMIT_WINDOW_MS / 1000)} s for this key owner. Retry in ${rl.retryAfterSec} s.`);
      return;
    }

    if (req.method !== 'POST' || req.routeOptions.url !== chatRoute) return;

    const cl = Number(req.headers['content-length'] ?? '0');
    if (cl > config.AGENT_BODY_LIMIT_BYTES) {
      sendOpenAIError(reply, 413, 'payload_too_large', `Request body exceeds ${config.AGENT_BODY_LIMIT_BYTES} bytes.`);
      return;
    }
    if (!principal.target) {
      sendOpenAIError(reply, 503, 'agent_not_configured',
        'No model is assigned to this key (or its provider is disabled). Ask the administrator to assign one.');
      return;
    }
    const admit = deps.fairness.tryAdmit({ clientId: principal.slotKey, maxConcurrency: principal.maxConcurrency, maxPending: principal.maxPending });
    if (admit !== 'ok') {
      reply.header('retry-after', '5');
      logger.warn({ contour: 'agent', slotKey: principal.slotKey, requestId, admit }, 'agent admission rejected');
      if (admit === 'client_full') {
        sendOpenAIError(reply, 429, 'too_many_parallel_requests',
          `Too many parallel requests for this key owner (${principal.maxConcurrency} running + ${principal.maxPending} queued). Retry shortly.`);
      } else {
        sendOpenAIError(reply, 503, 'server_overloaded', 'The proxy is at capacity. Retry shortly.');
      }
      return;
    }
    const ctx = req.agentContext;
    ctx.admitted = true;
    // Слот занят, а тело ещё не прочитано: медленная или брошенная загрузка не должна держать
    // его дольше AGENT_BODY_READ_TIMEOUT_MS. Обрыв соединения клиентом ловит onRequestAbort.
    ctx.bodyTimer = setTimeout(() => {
      delete ctx.bodyTimer;
      logger.warn({ contour: 'agent', slotKey: principal.slotKey, requestId }, 'agent request body not received in time; connection closed');
      releaseAgentAdmission(req, deps.fairness);
      req.raw.destroy();
    }, config.AGENT_BODY_READ_TIMEOUT_MS);
    ctx.bodyTimer.unref?.();
  });

  app.addHook('preValidation', async (req) => clearBodyTimer(req));
  app.addHook('onResponse', async (req) => {
    clearBodyTimer(req);
    releaseAgentAdmission(req, deps.fairness);
  });
  // Клиент оборвал соединение, в том числе посреди загрузки тела: обработчик тогда не
  // запускается и его finally не сработает — слот и запрос к провайдеру освобождаем здесь.
  app.addHook('onRequestAbort', async (req) => {
    clearBodyTimer(req);
    releaseAgentAdmission(req, deps.fairness);
    const live = req.agentContext?.liveId;
    if (live) deps.activeMetrics.abort(live);
  });
  // Ответы контура отдаются с того же origin, что и /admin: браузер не должен угадывать тип.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    return payload;
  });

  app.get('/models', async (req, reply) => {
    reply.header('cache-control', 'no-store').send({ object: 'list', data: modelList(req.agentContext!.principal) });
  });

  // Любое имя модели работает (подменяется назначенной), поэтому описание есть у любого.
  app.get('/models/*', async (req, reply) => {
    const principal = req.agentContext!.principal;
    const id = (req.params as { '*': string })['*'];
    if (!principal.target || !id) {
      sendOpenAIError(reply, 404, 'model_not_found', 'No model is assigned to this key.');
      return;
    }
    reply.header('cache-control', 'no-store').send({ id, object: 'model', created: MODEL_CREATED, owned_by: principal.target.provider.name });
  });

  app.post('/chat/completions', { bodyLimit: config.AGENT_BODY_LIMIT_BYTES }, async (req, reply) =>
    handleAgentChat(req, reply, { ...deps, providerLimiter }),
  );
}

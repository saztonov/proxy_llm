import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { logger } from './utils/logger.js';
import { openDb, type DbHandle } from './storage/db.js';
import { RequestsRepo } from './storage/requests-repo.js';
import { OpenRouterClient } from './upstream/openrouter-client.js';
import { ActiveRequests } from './dedup/active-requests.js';
import { loadClientRegistry, type ClientRegistry } from './clients/registry.js';
import { FairnessManager } from './concurrency/fairness.js';
import { startFairnessReconciler } from './concurrency/reconcile.js';
import { TelegramSender } from './alerts/telegram.js';
import { AlertEngine } from './alerts/rules.js';
import { startDailyDigest } from './alerts/digest.js';
import { StartupAlert } from './watchdog/startup-alert.js';
import { startWatchdogTicker } from './watchdog/ticker.js';
import { registerChatRoutes, ActiveMetrics } from './routes/chat-completions.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerDashboard } from './routes/dashboard.js';
import { dirname } from 'node:path';

export interface AppBundle {
  app: FastifyInstance;
  db: DbHandle;
  registry: ClientRegistry;
  fairness: FairnessManager;
  active: ActiveRequests;
  activeMetrics: ActiveMetrics;
  alerts: AlertEngine;
  startupAlert: StartupAlert;
  stopWatchdog: () => void;
  stopDigest: () => void;
  stopFairnessReconciler: () => void;
}

export async function buildApp(config: Config): Promise<AppBundle> {
  const db = openDb(config.DB_PATH);
  const repo = new RequestsRepo(db.db);

  const registry = loadClientRegistry(config);
  const active = new ActiveRequests(config.MAX_ACTIVE_DEDUP_KEYS);
  const fairness = new FairnessManager(
    registry,
    config.QUEUE_CONCURRENCY,
    config.QUEUE_MAX_PENDING,
    () => active.size(),
    config.MAX_ACTIVE_DEDUP_KEYS,
  );
  const activeMetrics = new ActiveMetrics();

  const client = new OpenRouterClient(config, logger);

  const telegram = new TelegramSender(
    { botToken: config.TELEGRAM_BOT_TOKEN, chatId: config.TELEGRAM_ADMIN_CHAT_ID },
    logger,
  );
  const alerts = new AlertEngine(config, telegram, repo, logger);

  const stateFilePath = `${dirname(config.DB_PATH)}/proxy_llm.state.json`;
  const startupAlert = new StartupAlert(stateFilePath, alerts, logger);

  const stopWatchdog = startWatchdogTicker(
    {
      intervalMs: 30_000,
      alertLongRequestMs: config.ALERT_LONG_REQUEST_MS,
      alertDiskFreeMinBytes: config.ALERT_DISK_FREE_MIN_BYTES,
      dbPath: config.DB_PATH,
    },
    activeMetrics,
    alerts,
    logger,
  );

  const stopDigest = startDailyDigest(alerts, logger);
  const stopFairnessReconciler = startFairnessReconciler(fairness, activeMetrics, logger);

  const app = Fastify({
    logger: false,
    bodyLimit: config.BODY_LIMIT_BYTES,
    trustProxy: true,
    disableRequestLogging: true,
  });

  app.setErrorHandler((err, _req, reply) => {
    const e = err as { name?: string; message?: string; code?: string; statusCode?: number };
    logger.error({ err: { name: e.name, message: e.message, code: e.code } }, 'fastify error');
    if (e.statusCode === 413) {
      reply.code(413).send({ error: { code: 'payload_too_large', message: e.message ?? 'too large' } });
      return;
    }
    if (e.statusCode === 400) {
      reply.code(400).send({ error: { code: 'invalid_request', message: e.message ?? 'bad request' } });
      return;
    }
    reply.code(e.statusCode ?? 500).send({
      error: { code: 'internal', message: 'internal proxy error' },
    });
  });

  await registerHealthRoutes(app, { db, config });
  await registerChatRoutes(app, {
    config,
    logger,
    registry,
    fairness,
    active,
    client,
    repo,
    alerts,
    activeMetrics,
  });
  await registerDashboard(app, { config, repo, activeMetrics });

  return {
    app,
    db,
    registry,
    fairness,
    active,
    activeMetrics,
    alerts,
    startupAlert,
    stopWatchdog,
    stopDigest,
    stopFairnessReconciler,
  };
}

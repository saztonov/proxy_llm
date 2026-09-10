import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { logger } from './utils/logger.js';
import { openDb, type DbHandle } from './storage/db.js';
import { createRepos, type Repos } from './storage/repos.js';
import { SecretBox } from './storage/secret-box.js';
import { OpenRouterClient } from './upstream/openrouter-client.js';
import { ActiveRequests } from './dedup/active-requests.js';
import { SiteRegistry } from './clients/site-registry.js';
import { bootstrapSiteRegistry } from './clients/site-bootstrap.js';
import { FairnessManager } from './concurrency/fairness.js';
import { startFairnessReconciler } from './concurrency/reconcile.js';
import { TelegramSender } from './alerts/telegram.js';
import { AlertEngine } from './alerts/rules.js';
import { startDailyDigest } from './alerts/digest.js';
import { startPriceSyncScheduler } from './billing/price-sync.js';
import { StartupAlert } from './watchdog/startup-alert.js';
import { startWatchdogTicker } from './watchdog/ticker.js';
import { registerChatRoutes, ActiveMetrics } from './routes/chat-completions.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerDashboard } from './routes/dashboard.js';
import { dirname } from 'node:path';
import { Agent as UndiciAgent } from 'undici';
import { AgentRegistry } from './clients/agent-registry.js';
import { OpenAICompatibleClient } from './upstream/openai-compatible-client.js';
import { agentPlugin } from './agent/plugin.js';
import { combineActiveSources } from './watchdog/composite-source.js';

export interface AppBundle {
  app: FastifyInstance;
  db: DbHandle;
  registry: SiteRegistry;
  repos: Repos;
  secrets: SecretBox;
  fairness: FairnessManager;
  active: ActiveRequests;
  activeMetrics: ActiveMetrics;
  alerts: AlertEngine;
  startupAlert: StartupAlert;
  stopWatchdog: () => void;
  stopDigest: () => void;
  stopFairnessReconciler: () => void;
  stopPriceSync: () => void;
  /** Все тикеры разом (остановка сервиса). */
  stopTickers: () => void;
  agentRegistry: AgentRegistry;
  agentFairness: FairnessManager;
  agentActiveMetrics: ActiveMetrics;
  stopAgentReconciler: () => void;
  /** Живые запросы всех контуров — для drain и abortAll при остановке. */
  activeSources: ActiveMetrics[];
}

export async function buildApp(config: Config): Promise<AppBundle> {
  const db = openDb(config.DB_PATH);
  const repos = createRepos(db.db);
  const repo = repos.requests;
  const billing = repos.billing;
  const secrets = new SecretBox(config.SECRETS_ENCRYPTION_KEY);

  // Реестр сайтов живёт в БД: clients.json и PROXY_INBOUND_TOKEN импортируются один раз,
  // дальше им управляют админка и CLI (см. clients/site-bootstrap.ts).
  bootstrapSiteRegistry({
    db: db.db,
    config,
    siteClients: repos.siteClients,
    siteTokens: repos.siteTokens,
    settings: repos.settings,
    secrets,
    logger,
  });
  const registry = new SiteRegistry({
    config,
    siteClients: repos.siteClients,
    siteTokens: repos.siteTokens,
    secrets,
    logger,
  });
  const active = new ActiveRequests(config.MAX_ACTIVE_DEDUP_KEYS);
  const fairness = new FairnessManager(
    registry,
    config.QUEUE_CONCURRENCY,
    config.QUEUE_MAX_PENDING,
    () => active.size(),
    config.MAX_ACTIVE_DEDUP_KEYS,
  );
  registry.onReload((clients) => fairness.syncClients(clients));
  const activeMetrics = new ActiveMetrics();

  // Агентский контур: свой реестр, свой fairness (агенты не выедают очередь порталов и
  // наоборот), свои живые запросы и отдельный пул соединений к провайдерам — десятки долгих
  // стримов не должны занимать сокеты, через которые ходят сайты.
  const agentRegistry = new AgentRegistry({
    config,
    agentTokens: repos.agentTokens,
    providers: repos.providers,
    settings: repos.settings,
    secrets,
    logger,
  });
  const agentFairness = new FairnessManager(
    agentRegistry,
    config.AGENT_QUEUE_CONCURRENCY,
    config.AGENT_QUEUE_MAX_PENDING,
    () => 0,
    1,
  );
  agentRegistry.onReload((tenants) => agentFairness.syncClients(tenants));
  const agentActiveMetrics = new ActiveMetrics();
  const agentDispatcher = new UndiciAgent({
    connections: config.AGENT_UPSTREAM_POOL_CONNECTIONS,
    pipelining: 1,
    keepAliveTimeout: 30_000,
  });
  const agentClient = new OpenAICompatibleClient(config, logger, agentDispatcher);

  const client = new OpenRouterClient(config, logger);

  const telegram = new TelegramSender(
    { botToken: config.TELEGRAM_BOT_TOKEN, chatId: config.TELEGRAM_ADMIN_CHAT_ID },
    logger,
  );
  const alerts = new AlertEngine(config, telegram, repo, logger, billing);

  const stateFilePath = `${dirname(config.DB_PATH)}/proxy_llm.state.json`;
  const startupAlert = new StartupAlert(stateFilePath, alerts, logger);

  const stopWatchdog = startWatchdogTicker(
    {
      intervalMs: 30_000,
      alertLongRequestMs: config.ALERT_LONG_REQUEST_MS,
      alertDiskFreeMinBytes: config.ALERT_DISK_FREE_MIN_BYTES,
      dbPath: config.DB_PATH,
    },
    combineActiveSources(activeMetrics, agentActiveMetrics),
    alerts,
    logger,
  );

  const stopDigest = startDailyDigest(alerts, logger);
  const stopFairnessReconciler = startFairnessReconciler(fairness, activeMetrics, logger);
  const stopAgentReconciler = startFairnessReconciler(agentFairness, agentActiveMetrics, logger);
  const stopPriceSync = startPriceSyncScheduler({ config, billing, logger });

  const app = Fastify({
    logger: false,
    bodyLimit: config.BODY_LIMIT_BYTES,
    // Доверяем ровно одному хопу — локальному nginx. `true` брал бы крайний левый адрес из
    // X-Forwarded-For, который клиент подделывает сам: rate-limit и журнал видели бы чужой IP.
    trustProxy: 1,
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
    billing,
    alerts,
    activeMetrics,
  });
  await registerDashboard(app, { config, repo, billing, activeMetrics });
  await app.register(agentPlugin, {
    prefix: '/agent/v1',
    deps: {
      config,
      logger,
      registry: agentRegistry,
      fairness: agentFairness,
      activeMetrics: agentActiveMetrics,
      client: agentClient,
      repo,
      billing,
      alerts,
    },
  });
  app.addHook('onClose', async () => {
    await agentDispatcher.close();
  });

  return {
    app,
    db,
    registry,
    repos,
    secrets,
    fairness,
    active,
    activeMetrics,
    alerts,
    startupAlert,
    stopWatchdog,
    stopDigest,
    stopFairnessReconciler,
    stopPriceSync,
    stopTickers: () => {
      stopWatchdog();
      stopDigest();
      stopFairnessReconciler();
      stopAgentReconciler();
      stopPriceSync();
    },
    activeSources: [activeMetrics, agentActiveMetrics],
    agentRegistry,
    agentFairness,
    agentActiveMetrics,
    stopAgentReconciler,
  };
}

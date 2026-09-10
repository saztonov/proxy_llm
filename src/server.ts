import { loadConfig, estimateMemoryBudget } from './config.js';
import { logger } from './utils/logger.js';
import { buildApp, type AppBundle } from './app.js';
import { gracefulShutdown } from './shutdown.js';
import { sanitizeErrorForLog } from './utils/sanitize-error.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const mem = estimateMemoryBudget(config);
  if (!mem.ok) {
    logger.warn(
      { estimatedBytes: mem.estimatedBytes, budgetBytes: mem.budgetBytes },
      'memory budget exceeded: queued request bodies may not fit into MemoryMax (see MEMORY_BUDGET_BYTES)',
    );
  }
  const bundle = await buildApp(config);

  await bundle.startupAlert.fire();

  await bundle.app.listen({ host: config.LISTEN_HOST, port: config.LISTEN_PORT });
  logger.info(
    { host: config.LISTEN_HOST, port: config.LISTEN_PORT, model: config.OPENROUTER_MODEL },
    'proxy_llm started',
  );

  installShutdownHandlers(config.GRACEFUL_DRAIN_MS, bundle);
}

function installShutdownHandlers(drainMs: number, bundle: AppBundle): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal, drainMs }, 'graceful shutdown started');

    await gracefulShutdown(bundle, { drainMs, logger });
    process.exit(0);
  };

  // Ручная правка реестра в БД (sqlite3, CLI): `systemctl kill -s HUP proxy_llm` применяет её
  // без рестарта. Ошибка сборки снапшота оставляет прежний в силе.
  process.on('SIGHUP', () => {
    try {
      const diff = bundle.registry.reload();
      bundle.agentRegistry.reload();
      logger.info({ ...diff }, 'SIGHUP: site and agent registries reloaded');
    } catch (err) {
      logger.error({ err: sanitizeErrorForLog(err) }, 'SIGHUP reload failed; previous snapshot kept');
    }
  });
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: sanitizeErrorForLog(err) }, 'uncaughtException');
  });
  process.on('unhandledRejection', (err) => {
    logger.error({ err: sanitizeErrorForLog(err) }, 'unhandledRejection');
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err: sanitizeErrorForLog(err) }, 'failed to start proxy_llm');
  process.exit(1);
});

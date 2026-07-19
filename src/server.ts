import { loadConfig } from './config.js';
import { logger } from './utils/logger.js';
import { buildApp, type AppBundle } from './app.js';
import { sanitizeErrorForLog } from './utils/sanitize-error.js';

async function main(): Promise<void> {
  const config = loadConfig();
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

    bundle.stopWatchdog();
    bundle.stopDigest();
    bundle.stopFairnessReconciler();

    try {
      await bundle.app.close();
    } catch (err) {
      logger.warn({ err: sanitizeErrorForLog(err) }, 'app.close threw');
    }

    // Дать активным запросам шанс завершиться.
    const deadline = Date.now() + drainMs;
    while (bundle.activeMetrics.size() > 0 && Date.now() < deadline) {
      await sleep(200);
    }

    if (bundle.activeMetrics.size() > 0) {
      logger.warn({ stillActive: bundle.activeMetrics.size() }, 'drain timeout, exiting anyway');
    }

    bundle.startupAlert.recordShutdown();

    try {
      bundle.db.close();
    } catch (err) {
      logger.warn({ err: sanitizeErrorForLog(err) }, 'db.close threw');
    }

    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: sanitizeErrorForLog(err) }, 'uncaughtException');
  });
  process.on('unhandledRejection', (err) => {
    logger.error({ err: sanitizeErrorForLog(err) }, 'unhandledRejection');
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err: sanitizeErrorForLog(err) }, 'failed to start proxy_llm');
  process.exit(1);
});

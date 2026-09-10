import { SETTING, type SettingsRepo } from '../storage/settings-repo.js';
import type { Logger } from '../utils/logger.js';
import { sanitizeErrorForLog } from '../utils/sanitize-error.js';

export interface RegistryWatcherOptions {
  settings: SettingsRepo;
  /** Перечитать реестры обоих контуров (бросает, если снапшот не собрался). */
  reload: () => void;
  intervalMs: number;
  logger: Logger;
}

/**
 * CLI правит реестры прямо в БД и отмечает это новым значением settings.registry_generation.
 * Сервис раз в несколько секунд сверяет отметку (один PK-lookup) и перечитывает реестры:
 * отзыв ключа из CLI начинает действовать без SIGHUP и без рестарта.
 *
 * Правки из админки сюда не относятся — они публикуют снапшот сразу в своей транзакции.
 * Если сборка снапшота упала, остаётся прежний; повтор — следующей правкой или SIGHUP.
 */
export function startRegistryWatcher(opts: RegistryWatcherOptions): () => void {
  let seen = opts.settings.get(SETTING.registryGeneration);
  const tick = (): void => {
    let current: string | null;
    try {
      current = opts.settings.get(SETTING.registryGeneration);
    } catch (err) {
      opts.logger.warn({ err: sanitizeErrorForLog(err) }, 'registry watcher: settings read failed');
      return;
    }
    if (current === seen) return;
    seen = current;
    try {
      opts.reload();
      opts.logger.info({ generation: current }, 'registries reloaded after an external change (CLI)');
    } catch (err) {
      opts.logger.error({ err: sanitizeErrorForLog(err) }, 'registry reload after an external change failed; previous snapshot kept');
    }
  };
  const timer = setInterval(tick, opts.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

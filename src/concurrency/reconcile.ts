import type { FairnessManager } from './fairness.js';
import type { ActiveMetrics } from '../routes/chat-completions.js';
import type { Logger } from '../utils/logger.js';

/** Сколько подряд тиков превышение должно держаться, чтобы считаться утечкой. */
const SUSTAIN_TICKS = 4;

/**
 * Периодически сверяет admission-счётчики FairnessManager с фактическим числом
 * admitted-запросов из ActiveMetrics и самовосстанавливает утечку слотов.
 *
 * Корректируется НЕ мгновенное расхождение, а только устойчивое — минимальное превышение
 * за окно из SUSTAIN_TICKS наблюдений. Причина: слот выдаётся в onRequest-хуке (до чтения
 * тела), а в ActiveMetrics запрос попадает уже внутри обработчика, после парсинга. Для тел
 * на сотни килобайт это окно порядка секунд, и тик, попавший в него, видит расхождение у
 * здорового запроса. Наблюдение 20-21.07.2026: все три «утечки» за 30 часов оказались
 * именно такими — в каждом случае запрос того же клиента (155-483 КБ, ~2.1 с) был в полёте
 * ровно в секунду тика. Мгновенная коррекция обнуляла слот живого запроса, то есть снимала
 * лимит конкурентности вместо того, чтобы его чинить.
 *
 * Минимум по окну разделяет эти случаи надёжно: настоящая утечка держится вечно и даёт
 * положительный минимум даже под нагрузкой (leaked + live против live), а окно парсинга
 * исчезает на следующем тике и роняет минимум в ноль. Плата — утечка живёт до
 * SUSTAIN_TICKS × intervalMs (2 минуты) вместо одного тика; инцидент estimat, ради
 * которого сверка и появилась, длился двое суток.
 */
export function startFairnessReconciler(
  fairness: FairnessManager,
  activeMetrics: ActiveMetrics,
  logger: Logger,
  intervalMs = 30_000,
  sustainTicks = SUSTAIN_TICKS,
): () => void {
  // scope → превышение на последних sustainTicks тиках.
  const history = new Map<string, number[]>();

  const tick = (): void => {
    const drift = fairness.measureDrift(
      activeMetrics.countAdmittedByClient(),
      activeMetrics.countAdmittedTotal(),
    );
    const excessNow = new Map(drift.map((d) => [d.scope, d.trackedActive - d.actualActive]));

    // Пройти надо и по scope без расхождения: именно нулевые отсчёты роняют минимум и
    // отсеивают запрос, который просто был в полёте.
    for (const scope of new Set([...history.keys(), ...excessNow.keys()])) {
      const samples = history.get(scope) ?? [];
      samples.push(excessNow.get(scope) ?? 0);
      if (samples.length > sustainTicks) samples.shift();
      history.set(scope, samples);

      if (samples.length < sustainTicks) continue;
      const sustained = Math.min(...samples);
      if (sustained <= 0) {
        if (samples.some((s) => s > 0)) {
          logger.debug({ scope, samples: [...samples] }, 'fairness drift transient, not corrected');
        }
        continue;
      }

      fairness.releaseLeaked(scope, sustained);
      logger.warn(
        { scope, leakedSlots: sustained, windowTicks: sustainTicks, samples: [...samples] },
        'fairness admission leak corrected',
      );
      // Обнуляем окно: иначе та же утечка «подтвердится» ещё раз на следующем тике.
      history.set(scope, []);
    }
  };

  const interval = setInterval(tick, intervalMs);
  interval.unref?.();
  return () => clearInterval(interval);
}

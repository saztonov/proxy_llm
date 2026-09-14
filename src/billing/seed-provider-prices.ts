import type Database from 'better-sqlite3';
import type { Repos } from '../storage/repos.js';
import type { Logger } from '../utils/logger.js';
import type { ProviderPrice } from './provider-pricing.js';
import { repriceProviderModel } from './provider-reprice.js';

/**
 * Встроенные прайсы известных провайдеров — чтобы оценка стоимости работала сразу, без ручного
 * ввода. Цены живут дальше как обычные версии в provider_model_prices: админ меняет их кнопкой
 * «Цены», а удалённая им цена повторно не появится (отметка ставится на провайдера).
 *
 * При смене прайса провайдером новую версию лучше вводить в админке с датой начала действия.
 * Если нужно обновить встроенный прайс, заводится новый SEED_VERSION с новыми ценами и датой
 * effectiveFrom — старые запросы останутся посчитанными по старым ценам.
 */

/** DeepSeek: пик 01–04 и 06–10 UTC в будни, всё остальное время вдвое дешевле. */
const DEEPSEEK_PEAK: Pick<ProviderPrice, 'peakHoursUtc' | 'peakWeekdaysOnly'> = {
  peakHoursUtc: [[1, 4], [6, 10]],
  peakWeekdaysOnly: true,
};

const DEEPSEEK_FLASH: ProviderPrice = {
  input: 0.3, cacheRead: 0.006, output: 1.2,
  offPeak: { input: 0.15, cacheRead: 0.003, output: 0.6 },
  ...DEEPSEEK_PEAK,
};

const DEEPSEEK_V4_PRO: ProviderPrice = {
  input: 1.32, cacheRead: 0.044, output: 3.96,
  offPeak: { input: 0.66, cacheRead: 0.022, output: 1.98 },
  ...DEEPSEEK_PEAK,
};

interface KnownPriceList {
  /** Меняется при обновлении прайса: входит в ключ отметки. */
  seedVersion: string;
  host: string;
  /** С какого момента действуют цены; 0 — для всей истории. */
  effectiveFrom: number;
  models: Readonly<Record<string, ProviderPrice>>;
}

/** Источник: https://api-docs.deepseek.com/quick_start/pricing (сентябрь 2026). */
export const KNOWN_PRICE_LISTS: readonly KnownPriceList[] = [
  {
    seedVersion: 'deepseek-2026-09',
    host: 'api.deepseek.com',
    effectiveFrom: 0,
    models: {
      'deepseek-flash': DEEPSEEK_FLASH,
      // Старые имена DeepSeek обслуживает моделью V4.1-Flash по её цене.
      'deepseek-v4-flash': DEEPSEEK_FLASH,
      'deepseek-v4-flash-vision-exp': DEEPSEEK_FLASH,
      'deepseek-v4-pro': DEEPSEEK_V4_PRO,
    },
  },
];

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export interface SeedDeps {
  db: Database.Database;
  repos: Repos;
  logger: Logger;
  now?: number;
}

/**
 * Заполняет встроенные цены для подходящих провайдеров, у которых этого ещё не делали, и
 * переоценивает их прошлые запросы. Модель, для которой админ уже задал цену, не трогается.
 * onlyProviderId — только для одного провайдера (сразу после его создания в админке).
 * Возвращает число добавленных цен. Ошибка не роняет старт: учёт вторичен.
 */
export function seedKnownProviderPrices(deps: SeedDeps, onlyProviderId?: number): number {
  const { repos, logger } = deps;
  const now = deps.now ?? Date.now();
  let inserted = 0;
  for (const provider of repos.providers.list()) {
    if (onlyProviderId !== undefined && provider.id !== onlyProviderId) continue;
    const host = hostOf(provider.base_url);
    for (const list of KNOWN_PRICE_LISTS) {
      if (host !== list.host) continue;
      const marker = `price_seed:${list.seedVersion}:${provider.id}`;
      if (repos.settings.get(marker) !== null) continue;
      try {
        const counts = deps.db.transaction(() => {
          const priced = new Set(repos.providerPrices.listLatest(provider.id).map((v) => v.model));
          let added = 0;
          let recalculated = 0;
          for (const [model, price] of Object.entries(list.models)) {
            if (priced.has(model)) continue;
            repos.providerPrices.insert({ provider_id: provider.id, model, effective_from: list.effectiveFrom, price, created_by: null }, now);
            recalculated += repriceProviderModel(repos.providerPrices, provider.id, model, list.effectiveFrom);
            added += 1;
          }
          repos.settings.set(marker, String(now), now);
          return { added, recalculated };
        })();
        inserted += counts.added;
        if (counts.added > 0) {
          logger.info({ providerId: provider.id, provider: provider.name, prices: list.seedVersion, ...counts }, 'built-in model prices added');
        }
      } catch (err) {
        logger.warn({ providerId: provider.id, err: String(err) }, 'built-in model prices were not added');
      }
    }
  }
  return inserted;
}

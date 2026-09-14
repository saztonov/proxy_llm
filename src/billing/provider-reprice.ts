import type { ProviderPricesRepo } from '../storage/provider-prices-repo.js';
import { estimateProviderCost } from './provider-pricing.js';

/**
 * Переоценивает попытки агентского контура по модели провайдера начиная с fromTs — после
 * того как админ задал или сменил цену. Каждая попытка берёт версию цены, действовавшую в
 * момент её начала. Вызывать внутри транзакции вместе с записью цены.
 */
export function repriceProviderModel(prices: ProviderPricesRepo, providerId: number, model: string, fromTs: number): number {
  const rows = prices.repriceRows(providerId, model, fromTs);
  for (const r of rows) {
    const version = prices.priceAt(providerId, model, r.ts_started);
    const est = estimateProviderCost(
      version?.price ?? null,
      {
        ...(r.prompt_tokens !== null ? { promptTokens: r.prompt_tokens } : {}),
        ...(r.completion_tokens !== null ? { completionTokens: r.completion_tokens } : {}),
        ...(r.cached_tokens !== null ? { cachedTokens: r.cached_tokens } : {}),
        ...(r.cache_write_tokens !== null ? { cacheWriteTokens: r.cache_write_tokens } : {}),
      },
      r.ts_started,
    );
    prices.setEstimate(r.id, est.usd, est.quality, est.usd === null ? null : (version?.id ?? null));
  }
  return rows.length;
}

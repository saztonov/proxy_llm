import type { PriceVersionRow, EstQuality } from '../storage/billing-repo.js';
import type { NormalizedUsage } from '../upstream/usage.js';

/**
 * Каталожная оценка стоимости — ДИАГНОСТИКА, не бухгалтерский факт.
 *
 * Каталог публикует минимальную цену модели, а не цену провайдера, на которого фактически
 * ушёл роутинг, и не покрывает тарифные ступени, серверные инструменты и медиа. Поэтому
 * результат никогда не смешивается с usage.cost: в отчётах он идёт отдельной строкой с
 * пометкой «≈» и меткой качества, а там, где посчитать честно нельзя, оценки просто нет.
 */

export interface EstimateResult {
  usd: number | null;
  quality: EstQuality;
}

const NO_PRICE: EstimateResult = { usd: null, quality: 'no_price' };
const UNPRICEABLE: EstimateResult = { usd: null, quality: 'unpriceable' };

function num(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function estimateCost(
  version: PriceVersionRow | null,
  usage: NormalizedUsage | undefined,
  modelId: string | null,
): EstimateResult {
  if (!version) return NO_PRICE;

  // Считать нечем: цена зависит от того, куда ушёл роутинг, от длины промпта или от
  // платных инструментов. Пустая оценка честнее правдоподобного, но неверного числа.
  if (version.has_sentinel === 1 || version.has_overrides === 1) return UNPRICEABLE;
  if (usage?.hasServerTools) return UNPRICEABLE;
  // Суффикс :online включает платный web search, которого нет в базовой цене модели.
  if (modelId !== null && modelId.endsWith(':online')) return UNPRICEABLE;

  const promptTokens = usage?.promptTokens ?? 0;
  const completionTokens = usage?.completionTokens ?? 0;
  if (promptTokens === 0 && completionTokens === 0) return NO_PRICE;

  const pPrompt = num(version.price_prompt);
  const pCompletion = num(version.price_completion);
  if (promptTokens > 0 && pPrompt === null) return NO_PRICE;
  if (completionTokens > 0 && pCompletion === null) return NO_PRICE;

  const cached = usage?.cachedTokens ?? 0;
  const cacheWrite = usage?.cacheWriteTokens ?? 0;
  // prompt_tokens у OpenRouter ВКЛЮЧАЕТ кэш-чтение и кэш-запись: без вычитания они
  // посчитались бы дважды.
  const uncached = Math.max(0, promptTokens - cached - cacheWrite);

  const pCacheRead = num(version.price_cache_read);
  const pCacheWrite = num(version.price_cache_write);
  // Отсутствие цены кэша — не повод отказываться: падаем на обычную цену промпта, но
  // помечаем оценку как неполную (она завышена ровно на скидку за кэш).
  let quality: EstQuality = 'ok';
  if (cached > 0 && pCacheRead === null) quality = 'partial';
  if (cacheWrite > 0 && pCacheWrite === null) quality = 'partial';

  // reasoning_tokens входят в completion_tokens — отдельно не прибавляются.
  const usd =
    uncached * (pPrompt ?? 0) +
    cached * (pCacheRead ?? pPrompt ?? 0) +
    cacheWrite * (pCacheWrite ?? pPrompt ?? 0) +
    completionTokens * (pCompletion ?? 0) +
    (num(version.price_request) ?? 0);

  return { usd, quality };
}

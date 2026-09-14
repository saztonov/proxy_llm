import { z } from 'zod';
import type { NormalizedUsage } from '../upstream/usage.js';
import type { EstQuality } from '../storage/billing-repo.js';

/**
 * Цены моделей провайдеров агентского контура, заданные администратором.
 *
 * OpenAI-совместимые провайдеры (DeepSeek и др.) возвращают в usage только токены, денег в
 * ответе нет, а каталог OpenRouter к их моделям не относится. Стоимость считается здесь по
 * токенам и ценам из админки и идёт в отчёты как оценка «≈», не как факт: цифра верна ровно
 * настолько, насколько верно введён прайс.
 *
 * Цены — USD за 1 млн токенов, как их публикуют провайдеры. Тариф может зависеть от времени
 * суток (у DeepSeek вне пиковых часов всё вдвое дешевле): тогда задаются пиковые часы по UTC
 * и отдельный тариф для остального времени. Время берётся из начала попытки.
 */

const usdPerMillion = z.number().finite().min(0).max(100_000);

export const tariffSchema = z
  .object({
    /** Вход без кэша (cache miss). */
    input: usdPerMillion,
    /** Вход из кэша (cache hit); не задан — считается по цене входа и оценка помечается partial. */
    cacheRead: usdPerMillion.nullable().optional(),
    output: usdPerMillion,
  })
  .strict();

const hourRange = z
  .tuple([z.number().int().min(0).max(23), z.number().int().min(1).max(24)])
  .refine(([from, to]) => from < to, 'peak hours: start must be before end');

export const providerPriceSchema = tariffSchema
  .extend({
    /** Тариф вне пиковых часов; null/не задан — основной тариф действует всегда. */
    offPeak: tariffSchema.nullable().optional(),
    /** Пиковые часы UTC, [с, до) — конец не включается. */
    peakHoursUtc: z.array(hourRange).max(12).nullable().optional(),
    /** Пик только в будни (пн–пт); в выходные весь день по тарифу вне пика. */
    peakWeekdaysOnly: z.boolean().optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.offPeak && !(p.peakHoursUtc && p.peakHoursUtc.length > 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['peakHoursUtc'], message: 'off-peak tariff needs peak hours' });
    }
  });

export type Tariff = z.infer<typeof tariffSchema>;
export type ProviderPrice = z.infer<typeof providerPriceSchema>;

export interface ProviderEstimate {
  usd: number | null;
  quality: EstQuality;
}

const NO_PRICE: ProviderEstimate = { usd: null, quality: 'no_price' };

/** Разбор цены из БД; битая запись — null (попытка останется без оценки, а не упадёт). */
export function parseStoredPrice(json: string): ProviderPrice | null {
  try {
    const r = providerPriceSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** Действует ли в момент ts основной (пиковый) тариф. Без тарифа вне пика — всегда. */
export function isPeak(price: ProviderPrice, ts: number): boolean {
  if (!price.offPeak) return true;
  const d = new Date(ts);
  const day = d.getUTCDay();
  if (price.peakWeekdaysOnly && (day === 0 || day === 6)) return false;
  const hour = d.getUTCHours();
  return (price.peakHoursUtc ?? []).some(([from, to]) => hour >= from && hour < to);
}

export function tariffAt(price: ProviderPrice, ts: number): Tariff {
  return price.offPeak && !isPeak(price, ts) ? price.offPeak : price;
}

/**
 * Оценка стоимости попытки по токенам. prompt_tokens у OpenAI-совместимых провайдеров
 * включает токены из кэша (DeepSeek: prompt_cache_hit_tokens + prompt_cache_miss_tokens),
 * поэтому кэш вычитается из входа, иначе он посчитался бы дважды.
 */
export function estimateProviderCost(price: ProviderPrice | null, usage: NormalizedUsage | undefined, ts: number): ProviderEstimate {
  if (!price) return NO_PRICE;
  const prompt = usage?.promptTokens ?? 0;
  const completion = usage?.completionTokens ?? 0;
  if (prompt === 0 && completion === 0) return NO_PRICE;

  const t = tariffAt(price, ts);
  const cached = Math.min(usage?.cachedTokens ?? 0, prompt);
  const cacheWrite = Math.min(usage?.cacheWriteTokens ?? 0, prompt - cached);
  const uncached = prompt - cached - cacheWrite;
  const cacheReadPrice = t.cacheRead ?? null;
  const quality: EstQuality = cached > 0 && cacheReadPrice === null ? 'partial' : 'ok';

  const usd =
    (uncached * t.input + cached * (cacheReadPrice ?? t.input) + cacheWrite * t.input + completion * t.output) / 1_000_000;
  return { usd, quality };
}

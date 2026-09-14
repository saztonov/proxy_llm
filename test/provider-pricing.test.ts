import { describe, expect, it } from 'vitest';
import {
  estimateProviderCost, isPeak, providerPriceSchema, parseStoredPrice, type ProviderPrice,
} from '../src/billing/provider-pricing.js';

/** Прайс DeepSeek для deepseek-flash на сентябрь 2026: вне пика всё вдвое дешевле. */
const DEEPSEEK: ProviderPrice = {
  input: 0.3, cacheRead: 0.006, output: 1.2,
  offPeak: { input: 0.15, cacheRead: 0.003, output: 0.6 },
  peakHoursUtc: [[1, 4], [6, 10]],
  peakWeekdaysOnly: true,
};
const MON_0230 = Date.UTC(2026, 8, 14, 2, 30); // понедельник, пик
const MON_0400 = Date.UTC(2026, 8, 14, 4, 0); // конец диапазона не включается
const SAT_0230 = Date.UTC(2026, 8, 12, 2, 30); // суббота: пика нет

describe('provider pricing', () => {
  it('peak hours are UTC ranges with an exclusive end, weekends are off-peak when asked', () => {
    expect(isPeak(DEEPSEEK, MON_0230)).toBe(true);
    expect(isPeak(DEEPSEEK, MON_0400)).toBe(false);
    expect(isPeak(DEEPSEEK, SAT_0230)).toBe(false);
    expect(isPeak({ ...DEEPSEEK, peakWeekdaysOnly: false }, SAT_0230)).toBe(true);
    const flat: ProviderPrice = { input: 1, output: 2 };
    expect(isPeak(flat, SAT_0230)).toBe(true);
  });

  it('cached tokens are taken out of prompt tokens and priced separately', () => {
    const usage = { promptTokens: 1_000_000, cachedTokens: 900_000, completionTokens: 1_000_000 };
    expect(estimateProviderCost(DEEPSEEK, usage, MON_0230).usd).toBeCloseTo(0.03 + 0.0054 + 1.2, 10);
    expect(estimateProviderCost(DEEPSEEK, usage, SAT_0230).usd).toBeCloseTo((0.03 + 0.0054 + 1.2) / 2, 10);
  });

  it('a real DeepSeek usage row off-peak', () => {
    // usage из боевого журнала: prompt_cache_hit_tokens 261120, miss 256.
    const usage = { promptTokens: 261_376, cachedTokens: 261_120, completionTokens: 1_063 };
    const e = estimateProviderCost(DEEPSEEK, usage, SAT_0230);
    expect(e.quality).toBe('ok');
    expect(e.usd).toBeCloseTo((256 * 0.15 + 261_120 * 0.003 + 1_063 * 0.6) / 1_000_000, 12);
  });

  it('without a cache price the input price is used and the estimate is marked partial', () => {
    const e = estimateProviderCost({ input: 1, output: 2 }, { promptTokens: 100, cachedTokens: 50, completionTokens: 0 }, MON_0230);
    expect(e).toEqual({ usd: 100 / 1_000_000, quality: 'partial' });
  });

  it('no price or no tokens gives no estimate rather than zero', () => {
    expect(estimateProviderCost(null, { promptTokens: 10, completionTokens: 1 }, MON_0230)).toEqual({ usd: null, quality: 'no_price' });
    expect(estimateProviderCost(DEEPSEEK, undefined, MON_0230)).toEqual({ usd: null, quality: 'no_price' });
  });

  it('validates the stored shape', () => {
    expect(providerPriceSchema.safeParse(DEEPSEEK).success).toBe(true);
    expect(providerPriceSchema.safeParse({ input: 1, output: 1, offPeak: { input: 1, output: 1 } }).success).toBe(false);
    expect(providerPriceSchema.safeParse({ input: 1, output: 1, offPeak: { input: 1, output: 1 }, peakHoursUtc: [[5, 5]] }).success).toBe(false);
    expect(providerPriceSchema.safeParse({ input: -1, output: 1 }).success).toBe(false);
    expect(parseStoredPrice('not json')).toBeNull();
    expect(parseStoredPrice(JSON.stringify(DEEPSEEK))).toEqual(DEEPSEEK);
  });
});

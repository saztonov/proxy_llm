import { describe, expect, it } from 'vitest';
import { estimateCost } from '../src/billing/estimate-cost.js';
import type { PriceVersionRow } from '../src/storage/billing-repo.js';
import { normalizeUsage } from '../src/upstream/usage.js';

function version(overrides: Partial<PriceVersionRow> = {}): PriceVersionRow {
  return {
    id: 1,
    model_id: 'google/gemini-3.1-flash-lite',
    observed_at: Date.parse('2026-07-01T06:00:00Z'),
    observed_day: '2026-07-01',
    pricing_hash: 'h',
    pricing_json: '{}',
    price_prompt: '0.0000001', // $0.10 / 1M
    price_completion: '0.0000004', // $0.40 / 1M
    price_cache_read: null,
    price_cache_write: null,
    price_request: null,
    price_web_search: null,
    price_internal_reasoning: null,
    has_overrides: 0,
    has_sentinel: 0,
    ...overrides,
  };
}

const usage = (u: Record<string, unknown>) => normalizeUsage(u);

describe('estimateCost', () => {
  it('multiplies tokens by the catalog price', () => {
    const r = estimateCost(version(), usage({ prompt_tokens: 1_000_000, completion_tokens: 100_000 }), 'm');
    expect(r.quality).toBe('ok');
    expect(r.usd).toBeCloseTo(0.1 + 0.04, 12);
  });

  it('does not charge cached tokens twice', () => {
    // prompt_tokens ВКЛЮЧАЕТ cached_tokens: наивное умножение завысило бы расход.
    const v = version({ price_cache_read: '0.000000025' }); // 1/4 обычной цены
    const r = estimateCost(
      v,
      usage({
        prompt_tokens: 1_000_000,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 800_000 },
      }),
      'm',
    );
    // 200k по 1e-7 + 800k по 2.5e-8 = 0.02 + 0.02
    expect(r.usd).toBeCloseTo(0.04, 12);
    expect(r.quality).toBe('ok');
  });

  it('falls back to the prompt price when no cache price is published, and says so', () => {
    const r = estimateCost(
      version(),
      usage({ prompt_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 500_000 } }),
      'm',
    );
    expect(r.quality).toBe('partial');
    expect(r.usd).toBeCloseTo(0.1, 12); // весь промпт по обычной цене
  });

  it('does not add reasoning tokens on top of completion tokens', () => {
    const withReasoning = estimateCost(
      version(),
      usage({
        prompt_tokens: 0,
        completion_tokens: 100_000,
        completion_tokens_details: { reasoning_tokens: 90_000 },
      }),
      'm',
    );
    const without = estimateCost(version(), usage({ prompt_tokens: 0, completion_tokens: 100_000 }), 'm');
    expect(withReasoning.usd).toBe(without.usd);
  });

  it('adds a fixed per-request price when published', () => {
    const r = estimateCost(
      version({ price_request: '0.001' }),
      usage({ prompt_tokens: 1_000_000, completion_tokens: 0 }),
      'm',
    );
    expect(r.usd).toBeCloseTo(0.1 + 0.001, 12);
  });

  it('treats a free model as costing zero, not as unknown', () => {
    const r = estimateCost(
      version({ price_prompt: '0', price_completion: '0' }),
      usage({ prompt_tokens: 1000, completion_tokens: 500 }),
      'free/model:free',
    );
    expect(r.usd).toBe(0);
    expect(r.quality).toBe('ok');
  });

  it('refuses to estimate what it cannot know', () => {
    const u = usage({ prompt_tokens: 1000, completion_tokens: 100 });

    // Роутер: цена зависит от того, какую модель он выберет.
    expect(estimateCost(version({ has_sentinel: 1 }), u, 'openrouter/auto')).toMatchObject({
      usd: null,
      quality: 'unpriceable',
    });
    // Тарифные ступени по длине промпта.
    expect(estimateCost(version({ has_overrides: 1 }), u, 'm')).toMatchObject({
      usd: null,
      quality: 'unpriceable',
    });
    // Платный web search поверх базовой цены модели.
    expect(estimateCost(version(), u, 'perplexity/model:online')).toMatchObject({
      usd: null,
      quality: 'unpriceable',
    });
    expect(
      estimateCost(version(), usage({ prompt_tokens: 10, server_tool_use: { web_search_requests: 2 } }), 'm'),
    ).toMatchObject({ usd: null, quality: 'unpriceable' });
    // Цены вообще нет — модель не наблюдалась на момент запроса.
    expect(estimateCost(null, u, 'm')).toMatchObject({ usd: null, quality: 'no_price' });
    // Нужного компонента цены нет.
    expect(estimateCost(version({ price_completion: null }), u, 'm')).toMatchObject({
      usd: null,
      quality: 'no_price',
    });
    // Токенов нет — считать нечего.
    expect(estimateCost(version(), usage({ cost: 0.1 }), 'm')).toMatchObject({
      usd: null,
      quality: 'no_price',
    });
  });
});

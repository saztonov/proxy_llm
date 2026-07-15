import { describe, expect, it } from 'vitest';
import { resolveModel } from '../src/upstream/resolve-model.js';

const base = { defaultModel: 'default/model', allowedModels: [] as string[], fallbackModels: [] as string[] };

describe('resolveModel', () => {
  it('legacy (empty allowlist) ignores requested model, uses default', () => {
    const out = resolveModel('client/wants-this', { ...base });
    expect(out).toEqual({ ok: true, resolution: { model: 'default/model', fallbackModels: [] } });
  });

  it('no requested model → client default + fallbacks', () => {
    const out = resolveModel(undefined, { ...base, fallbackModels: ['fb/one'] });
    expect(out).toEqual({ ok: true, resolution: { model: 'default/model', fallbackModels: ['fb/one'] } });
  });

  it('allowlisted requested model → forwarded, no fallback array', () => {
    const out = resolveModel('b/two', { defaultModel: 'default/model', allowedModels: ['b/one', 'b/two'], fallbackModels: ['fb/x'] });
    expect(out).toEqual({ ok: true, resolution: { model: 'b/two', fallbackModels: [] } });
  });

  it('disallowed requested model → model_not_allowed with allowed list', () => {
    const out = resolveModel('c/three', { defaultModel: 'default/model', allowedModels: ['b/one', 'b/two'], fallbackModels: [] });
    expect(out).toEqual({ ok: false, code: 'model_not_allowed', allowed: ['b/one', 'b/two'] });
  });

  it('empty-string model treated as not provided → default', () => {
    const out = resolveModel('', { defaultModel: 'default/model', allowedModels: ['b/one'], fallbackModels: [] });
    expect(out).toEqual({ ok: true, resolution: { model: 'default/model', fallbackModels: [] } });
  });

  describe('sentinels', () => {
    const wildcard = { defaultModel: 'default/model', allowedModels: ['*'], fallbackModels: ['fb/one'] };

    it.each(['proxy', 'default', 'auto'])('%s under wildcard → default + fallbacks, never upstream', (sentinel) => {
      const out = resolveModel(sentinel, wildcard);
      expect(out).toEqual({ ok: true, resolution: { model: 'default/model', fallbackModels: ['fb/one'] } });
    });

    // Регрессия: заглушка не должна ловить 400 у клиента с явным списком — иначе доработка
    // клиента ("шли sentinel, если модель не нужна") ломала бы его же.
    it('sentinel under explicit allowlist → default, NOT model_not_allowed', () => {
      const out = resolveModel('proxy', { defaultModel: 'default/model', allowedModels: ['b/one'], fallbackModels: ['fb/one'] });
      expect(out).toEqual({ ok: true, resolution: { model: 'default/model', fallbackModels: ['fb/one'] } });
    });

    it.each(['Proxy', 'AUTO', 'Default'])('%s — case-insensitive', (sentinel) => {
      const out = resolveModel(sentinel, wildcard);
      expect(out).toEqual({ ok: true, resolution: { model: 'default/model', fallbackModels: ['fb/one'] } });
    });

    it('surrounding whitespace is trimmed', () => {
      const out = resolveModel('  proxy  ', wildcard);
      expect(out).toEqual({ ok: true, resolution: { model: 'default/model', fallbackModels: ['fb/one'] } });
    });

    // Матчинг по всей строке: реальный автороутер OpenRouter не должен глохнуть как заглушка.
    it('openrouter/auto is a real slug, not a sentinel', () => {
      const out = resolveModel('openrouter/auto', wildcard);
      expect(out).toEqual({ ok: true, resolution: { model: 'openrouter/auto', fallbackModels: [] } });
    });

    it.each([[123], [null], [{}], [['proxy']]])('non-string %s → default', (requested) => {
      const out = resolveModel(requested, wildcard);
      expect(out).toEqual({ ok: true, resolution: { model: 'default/model', fallbackModels: ['fb/one'] } });
    });
  });

  describe('wildcard', () => {
    const wildcard = { defaultModel: 'default/model', allowedModels: ['*'], fallbackModels: ['fb/one'] };

    it('any model is forwarded, and explicit choice still drops fallbacks', () => {
      const out = resolveModel('any/thing', wildcard);
      expect(out).toEqual({ ok: true, resolution: { model: 'any/thing', fallbackModels: [] } });
    });

    it('no model → default + fallbacks', () => {
      const out = resolveModel(undefined, wildcard);
      expect(out).toEqual({ ok: true, resolution: { model: 'default/model', fallbackModels: ['fb/one'] } });
    });

    it('wildcard mixed with explicit entries still allows anything', () => {
      const out = resolveModel('c/three', { defaultModel: 'default/model', allowedModels: ['*', 'b/one'], fallbackModels: [] });
      expect(out).toEqual({ ok: true, resolution: { model: 'c/three', fallbackModels: [] } });
    });

    it('real slug is trimmed before allowlist lookup', () => {
      const out = resolveModel('  b/two  ', { defaultModel: 'default/model', allowedModels: ['b/two'], fallbackModels: [] });
      expect(out).toEqual({ ok: true, resolution: { model: 'b/two', fallbackModels: [] } });
    });
  });
});

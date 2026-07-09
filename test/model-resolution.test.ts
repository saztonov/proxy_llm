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
});

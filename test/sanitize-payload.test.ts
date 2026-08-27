import { describe, expect, it } from 'vitest';
import { buildUpstreamPayload, clientWantedStreaming } from '../src/upstream/sanitize-payload.js';

describe('sanitize-payload', () => {
  it('removes all denylist fields and sets a single model', () => {
    const payload = buildUpstreamPayload(
      {
        messages: [{ role: 'user', content: 'hi' }],
        model: 'client/picked',
        models: ['evil/one'],
        provider: { order: ['anthropic'] },
        route: 'fallback',
        transforms: ['middle-out'],
        plugins: [{ id: 'web' }],
        stream: true,
        stream_options: { include_usage: true },
        debug: true,
        temperature: 0.2,
      },
      { model: 'proxy/configured', fallbackModels: [] },
    );

    expect(payload).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      model: 'proxy/configured',
      stream: false,
    });
    expect(payload.models).toBeUndefined();
  });

  it('uses models array when fallbacks configured, deletes model', () => {
    const payload = buildUpstreamPayload(
      { messages: [{ role: 'user', content: 'hi' }] },
      { model: 'proxy/primary', fallbackModels: ['proxy/secondary', 'proxy/tertiary'] },
    );
    expect(payload.models).toEqual(['proxy/primary', 'proxy/secondary', 'proxy/tertiary']);
    expect(payload.model).toBeUndefined();
    expect(payload.stream).toBe(false);
  });

  it('detects client streaming intent', () => {
    expect(clientWantedStreaming({ stream: true })).toBe(true);
    expect(clientWantedStreaming({ stream: false })).toBe(false);
    expect(clientWantedStreaming({})).toBe(false);
  });

  it('disables Qwen thinking for qwen/* models', () => {
    const payload = buildUpstreamPayload(
      { messages: [{ role: 'user', content: 'hi' }], max_tokens: 4096 },
      { model: 'qwen/qwen3.8-27b', fallbackModels: [] },
    );

    expect(payload).toMatchObject({
      model: 'qwen/qwen3.8-27b',
      max_tokens: 4096,
      reasoning: { effort: 'none' },
      chat_template_kwargs: { enable_thinking: false },
      enable_thinking: false,
      stream: false,
    });
  });

  it('does not override explicit Qwen thinking settings from client', () => {
    const payload = buildUpstreamPayload(
      {
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'high' },
        chat_template_kwargs: { enable_thinking: true },
        enable_thinking: true,
      },
      { model: 'qwen/qwen3-8b', fallbackModels: [] },
    );

    expect(payload.reasoning).toEqual({ effort: 'high' });
    expect(payload.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(payload.enable_thinking).toBe(true);
  });

  it('does not inject Qwen overrides for non-qwen models', () => {
    const payload = buildUpstreamPayload(
      { messages: [{ role: 'user', content: 'hi' }] },
      { model: 'google/gemini-2.5-flash', fallbackModels: [] },
    );

    expect(payload.reasoning).toBeUndefined();
    expect(payload.chat_template_kwargs).toBeUndefined();
    expect(payload.enable_thinking).toBeUndefined();
  });
});

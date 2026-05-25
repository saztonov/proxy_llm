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
});

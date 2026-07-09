const DENY_FIELDS = [
  'model',
  'models',
  'provider',
  'route',
  'transforms',
  'plugins',
  'stream',
  'stream_options',
  'debug',
] as const;

import type { ModelResolution } from './resolve-model.js';

export function buildUpstreamPayload(
  incoming: Record<string, unknown>,
  resolution: ModelResolution,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };
  for (const k of DENY_FIELDS) delete out[k];

  if (resolution.fallbackModels.length > 0) {
    out.models = [resolution.model, ...resolution.fallbackModels];
  } else {
    out.model = resolution.model;
  }
  out.stream = false;
  return out;
}

export function clientWantedStreaming(incoming: Record<string, unknown>): boolean {
  return incoming.stream === true;
}

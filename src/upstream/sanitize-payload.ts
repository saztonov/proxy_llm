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

/** Hybrid Qwen models burn completion budget on thinking traces unless disabled. */
const QWEN_MODEL_PREFIX = /^qwen\//i;

function applyModelPayloadOverrides(model: string, payload: Record<string, unknown>): void {
  if (!QWEN_MODEL_PREFIX.test(model)) return;

  if (payload.reasoning === undefined) {
    payload.reasoning = { effort: 'none' };
  }

  const existingKwargs = payload.chat_template_kwargs;
  if (existingKwargs === undefined) {
    payload.chat_template_kwargs = { enable_thinking: false };
  } else if (
    typeof existingKwargs === 'object' &&
    existingKwargs !== null &&
    !Array.isArray(existingKwargs)
  ) {
    const kwargs = existingKwargs as Record<string, unknown>;
    if (kwargs.enable_thinking === undefined) {
      kwargs.enable_thinking = false;
    }
  }

  if (payload.enable_thinking === undefined) {
    payload.enable_thinking = false;
  }
}

export function buildUpstreamPayload(
  incoming: Record<string, unknown>,
  resolution: ModelResolution,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };
  for (const k of DENY_FIELDS) delete out[k];

  if (resolution.fallbackModels.length > 0) {
    out.models = [resolution.model, ...resolution.fallbackModels];
    applyModelPayloadOverrides(resolution.model, out);
  } else {
    out.model = resolution.model;
    applyModelPayloadOverrides(resolution.model, out);
  }
  out.stream = false;
  return out;
}

export function clientWantedStreaming(incoming: Record<string, unknown>): boolean {
  return incoming.stream === true;
}

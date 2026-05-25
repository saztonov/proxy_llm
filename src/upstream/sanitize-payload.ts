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

export interface ModelConfig {
  model: string;
  fallbackModels: string[];
}

export function buildUpstreamPayload(
  incoming: Record<string, unknown>,
  modelConfig: ModelConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };
  for (const k of DENY_FIELDS) delete out[k];

  if (modelConfig.fallbackModels.length > 0) {
    out.models = [modelConfig.model, ...modelConfig.fallbackModels];
  } else {
    out.model = modelConfig.model;
  }
  out.stream = false;
  return out;
}

export function clientWantedStreaming(incoming: Record<string, unknown>): boolean {
  return incoming.stream === true;
}

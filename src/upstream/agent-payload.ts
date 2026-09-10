/** Как просить у провайдера usage в стриме (см. storage/providers-repo.ts, UsageMode). */
export type StreamUsageMode = 'openrouter' | 'stream_options' | 'none';

export interface AgentPayloadTarget {
  model: string;
  usageMode: StreamUsageMode;
}

export interface AgentPayload {
  payload: Record<string, unknown>;
  stream: boolean;
  /** Что прислал агент в `model` (для статистики «что просили»); подменяется всегда. */
  modelAsked: string | null;
}

/**
 * Поля маршрутизации OpenRouter, которыми агент мог бы обойти назначенную модель или
 * провайдера (fallback-цепочка, выбор провайдера, пресеты). Вырезаются всегда.
 */
const AGENT_DENY_FIELDS = ['models', 'provider', 'route', 'transforms', 'plugins', 'preset', 'debug'] as const;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Payload агентского контура: модель подменяется на назначенную, независимо от того, что
 * прислала IDE; всё остальное (messages, tools, tool_choice, response_format, reasoning,
 * max_tokens...) проходит как есть. Для стрима дополнительно просим usage — иначе расход
 * стримов нечем учесть.
 */
export function buildAgentPayload(incoming: Record<string, unknown>, target: AgentPayloadTarget): AgentPayload {
  const out: Record<string, unknown> = { ...incoming };
  for (const k of AGENT_DENY_FIELDS) delete out[k];

  const modelAsked = typeof incoming.model === 'string' ? incoming.model.slice(0, 128) : null;
  out.model = target.model;

  const stream = out.stream === true;
  if (!stream) {
    // OpenAI отвечает 400 на stream_options без stream:true.
    delete out.stream_options;
  } else if (target.usageMode === 'openrouter') {
    out.usage = { ...(asRecord(out.usage) ?? {}), include: true };
  } else if (target.usageMode === 'stream_options') {
    out.stream_options = { ...(asRecord(out.stream_options) ?? {}), include_usage: true };
  }
  return { payload: out, stream, modelAsked };
}

/**
 * Whitelist для headers, копируемых из upstream-ответа клиенту.
 * Fastify сам выставит content-length/transfer-encoding после re-serialize.
 */

export type FilteredHeaders = {
  'content-type'?: string;
  'x-proxy-request-id'?: string;
  'x-openrouter-request-id'?: string;
  [header: string]: string | undefined;
};

type UpstreamHeaders = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  if (typeof v === 'string') return v;
  return Array.isArray(v) && v[0] ? v[0] : undefined;
}

export function filterResponseHeaders(
  upstream: UpstreamHeaders,
  requestId: string,
  upstreamId: string | null,
): FilteredHeaders {
  const out: FilteredHeaders = {};
  out['content-type'] = first(upstream['content-type']) ?? 'application/json';
  out['x-proxy-request-id'] = requestId;
  if (upstreamId) out['x-openrouter-request-id'] = upstreamId;
  return out;
}

/**
 * Whitelist агентского контура. Сверх сайтового — retry-after (OpenAI SDK и IDE его уважают на
 * 429/503) и нейтральный x-upstream-request-id. Заголовки провайдера про его лимиты
 * (x-ratelimit-*) и www-authenticate не пропускаются: они про общий ключ провайдера, а не
 * про токен сотрудника, и лишь раскрывали бы, куда и с каким аккаунтом ходит прокси.
 */
export function agentResponseHeaders(
  upstream: UpstreamHeaders,
  requestId: string,
  upstreamId: string | null,
  kind: 'openrouter' | 'generic',
): FilteredHeaders {
  const out: FilteredHeaders = {};
  out['content-type'] = first(upstream['content-type']) ?? 'application/json';
  out['x-proxy-request-id'] = requestId;
  const retryAfter = first(upstream['retry-after']);
  if (retryAfter) out['retry-after'] = retryAfter;
  if (upstreamId) {
    out['x-upstream-request-id'] = upstreamId;
    if (kind === 'openrouter') out['x-openrouter-request-id'] = upstreamId;
  }
  return out;
}

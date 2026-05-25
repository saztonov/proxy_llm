/**
 * Whitelist для headers, копируемых из upstream-ответа клиенту.
 * Fastify сам выставит content-length/transfer-encoding после re-serialize.
 */

export interface FilteredHeaders {
  'content-type'?: string;
  'x-proxy-request-id'?: string;
  'x-openrouter-request-id'?: string;
}

export function filterResponseHeaders(
  upstream: Record<string, string | string[] | undefined>,
  requestId: string,
  upstreamId: string | null,
): FilteredHeaders {
  const out: FilteredHeaders = {};
  const contentType = upstream['content-type'];
  if (typeof contentType === 'string') {
    out['content-type'] = contentType;
  } else if (Array.isArray(contentType) && contentType[0]) {
    out['content-type'] = contentType[0];
  } else {
    out['content-type'] = 'application/json';
  }
  out['x-proxy-request-id'] = requestId;
  if (upstreamId) out['x-openrouter-request-id'] = upstreamId;
  return out;
}

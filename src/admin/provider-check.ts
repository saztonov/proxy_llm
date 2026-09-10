import { request as undiciRequest, type Dispatcher } from 'undici';
import type { AgentProvider } from '../clients/agent-registry.js';
import { readBodyWithLimit, safeParseJson } from '../upstream/read-body-with-limit.js';
import { sanitizeErrorForLog } from '../utils/sanitize-error.js';
import { sanitizeForLog } from '../utils/sanitize.js';
import { providerSecrets, redactSecrets } from '../upstream/provider-headers.js';

export interface ProviderCheckResult {
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number;
  modelsCount: number | null;
  sampleModels: string[];
  error?: string;
}

function scrub(text: string, p: AgentProvider): string {
  return sanitizeForLog(redactSecrets(text, providerSecrets(p)), 300);
}

async function get(url: string, p: AgentProvider, timeoutMs: number, dispatcher?: Dispatcher): Promise<{ status: number; text: string }> {
  const res = await undiciRequest(url, {
    method: 'GET',
    headers: { ...p.extraHeaders, accept: 'application/json', ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
    ...(dispatcher ? { dispatcher } : {}),
  });
  return { status: res.statusCode, text: await readBodyWithLimit(res.body, 8 * 1024 * 1024) };
}

/**
 * «Проверить провайдера» из админки: GET {base}/models с ключом. У OpenRouter каталог
 * публичен и отвечает и без ключа, поэтому для него ключ дополнительно проверяется GET /key.
 * Тело ответа при ошибке не возвращается: проверка не должна становиться окном для чтения
 * внутренних сервисов по произвольному адресу. Текст сетевой ошибки чистится от секретов.
 */
export async function checkProvider(p: AgentProvider, timeoutMs: number, dispatcher?: Dispatcher): Promise<ProviderCheckResult> {
  const t0 = Date.now();
  const fail = (httpStatus: number | null, error: string): ProviderCheckResult => ({
    ok: false, httpStatus, latencyMs: Date.now() - t0, modelsCount: null, sampleModels: [], error,
  });
  try {
    const models = await get(`${p.baseUrl}/models`, p, timeoutMs, dispatcher);
    if (models.status !== 200) return fail(models.status, `the provider answered HTTP ${models.status} to GET /models`);
    const parsed = safeParseJson(models.text) as { data?: unknown } | null;
    const data = parsed && typeof parsed === 'object' && Array.isArray(parsed.data) ? parsed.data : null;
    if (!data) return fail(200, 'unexpected response: no data[] with models');
    const ids = data
      .map((m) => (m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string' ? (m as { id: string }).id : null))
      .filter((id): id is string => id !== null);
    if (p.kind === 'openrouter' && p.apiKey) {
      const key = await get(`${p.baseUrl}/key`, p, timeoutMs, dispatcher);
      if (key.status !== 200) return fail(key.status, `API key rejected by OpenRouter (GET /key → ${key.status})`);
    }
    return { ok: true, httpStatus: 200, latencyMs: Date.now() - t0, modelsCount: ids.length, sampleModels: ids.slice(0, 20) };
  } catch (err) {
    return fail(null, scrub(sanitizeErrorForLog(err).message, p));
  }
}

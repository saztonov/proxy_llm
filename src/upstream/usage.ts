/**
 * Нормализация объекта `usage` из ответа OpenRouter.
 *
 * Зачем строгая валидация: раньше `parsedObj.usage` кастовался в тип без проверок, и
 * нечисловое значение (например `usage: { prompt_tokens: {} }`) роняло bind в better-sqlite3.
 * persistRecord ловит это исключение в try/catch — и теряется ВСЯ строка журнала, а не одно
 * поле. Здесь негодное поле становится undefined (→ NULL в БД), остальные выживают.
 *
 * OpenRouter отдаёт usage автоматически для non-streaming ответов; `cost` — сумма, реально
 * списанная с аккаунта (кредиты ≈ USD 1:1).
 */

/** Максимум, который кладём в usage_json: страховка от неожиданно раздутого объекта. */
const RAW_LIMIT_BYTES = 8192;

export interface NormalizedUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  upstreamInferenceCostUsd?: number;
  isByok?: boolean;
  /**
   * В ответе есть платные серверные инструменты (web search и т.п.). На факт не влияет —
   * usage.cost их уже включает, — но каталожная оценка такой вызов посчитать не может.
   */
  hasServerTools?: boolean;
  /** Исходный usage дословно (JSON, обрезанный до RAW_LIMIT_BYTES) — для аудита и добэкфилла. */
  raw?: string;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** Конечное неотрицательное число; строки принимаем — OpenRouter иногда отдаёт цены строкой. */
function money(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Токены — только конечные неотрицательные целые. */
function tokens(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? n : undefined;
}

function truncateRaw(usage: unknown): string | undefined {
  try {
    const s = JSON.stringify(usage);
    if (typeof s !== 'string') return undefined;
    return Buffer.byteLength(s, 'utf8') > RAW_LIMIT_BYTES ? s.slice(0, RAW_LIMIT_BYTES) : s;
  } catch {
    // Циклические ссылки в распарсенном JSON невозможны, но JSON.stringify может бросить на BigInt.
    return undefined;
  }
}

/**
 * Приводит произвольное значение к NormalizedUsage.
 * Возвращает undefined, только если usage вообще не объект — иначе объект с теми полями,
 * которые прошли валидацию.
 */
export function normalizeUsage(raw: unknown): NormalizedUsage | undefined {
  const u = asRecord(raw);
  if (!u) return undefined;

  const promptDetails = asRecord(u.prompt_tokens_details);
  const completionDetails = asRecord(u.completion_tokens_details);
  const costDetails = asRecord(u.cost_details);

  const out: NormalizedUsage = {};

  const promptTokens = tokens(u.prompt_tokens);
  if (promptTokens !== undefined) out.promptTokens = promptTokens;
  const completionTokens = tokens(u.completion_tokens);
  if (completionTokens !== undefined) out.completionTokens = completionTokens;
  const totalTokens = tokens(u.total_tokens);
  if (totalTokens !== undefined) out.totalTokens = totalTokens;

  const cachedTokens = tokens(promptDetails?.cached_tokens);
  if (cachedTokens !== undefined) out.cachedTokens = cachedTokens;
  const cacheWriteTokens = tokens(promptDetails?.cache_write_tokens);
  if (cacheWriteTokens !== undefined) out.cacheWriteTokens = cacheWriteTokens;
  const reasoningTokens = tokens(completionDetails?.reasoning_tokens);
  if (reasoningTokens !== undefined) out.reasoningTokens = reasoningTokens;

  const costUsd = money(u.cost);
  if (costUsd !== undefined) out.costUsd = costUsd;
  const upstreamCost = money(costDetails?.upstream_inference_cost);
  if (upstreamCost !== undefined) out.upstreamInferenceCostUsd = upstreamCost;

  if (typeof u.is_byok === 'boolean') out.isByok = u.is_byok;

  if (u.server_tool_use !== undefined || u.web_search_requests !== undefined) {
    out.hasServerTools = true;
  }

  const rawJson = truncateRaw(raw);
  if (rawJson !== undefined) out.raw = rawJson;

  return out;
}

/** Есть ли в usage хоть что-то денежно значимое (для выбора usage_source). */
export function hasCost(u: NormalizedUsage | undefined): boolean {
  return u?.costUsd !== undefined;
}

import { request as undiciRequest } from 'undici';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { BillingRepo, PriceVersionInput } from '../storage/billing-repo.js';
import { readBodyWithLimit } from '../upstream/read-body-with-limit.js';
import { sanitizeErrorForLog } from '../utils/sanitize-error.js';
import { billingDay, billingHour } from './billing-time.js';

/**
 * Суточная синхронизация прайс-листа OpenRouter.
 *
 * Каталог отдаёт ТЕКУЩИЕ цены — задним числом историю не восстановить. Поэтому снимок
 * делается каждые сутки, а версия модели пишется только при изменении pricing: так история
 * остаётся полной и при этом компактной (~400 строк на старте, дальше десятки в год).
 *
 * Важно: observed_at — момент, когда МЫ увидели цену, а не когда она вступила в силу.
 */

const pricingSchema = z.record(z.unknown());

const modelEntrySchema = z
  .object({
    id: z.string().min(1),
    pricing: pricingSchema.optional(),
  })
  .passthrough();

const modelsResponseSchema = z.object({
  data: z.array(z.unknown()),
});

export interface PriceSyncDeps {
  config: Config;
  billing: BillingRepo;
  logger: Logger;
  now?: () => number;
}

export interface PriceSyncResult {
  ok: boolean;
  day: string;
  modelsSeen: number;
  versionsWritten: number;
  httpStatus: number | null;
  error?: string;
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim() !== '') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** Цена < 0 — sentinel роутеров («цена зависит от выбранной модели»), считать по ней нельзя. */
function isSentinel(v: unknown): boolean {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n < 0;
}

/** Стабильный хэш: ключи сортируются, иначе перестановка полей выглядела бы сменой цены. */
function pricingHash(pricing: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.keys(pricing)
      .sort()
      .map((k) => [k, pricing[k]]),
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function toVersion(
  modelId: string,
  pricing: Record<string, unknown>,
  observedAt: number,
  day: string,
): PriceVersionInput {
  return {
    model_id: modelId,
    observed_at: observedAt,
    observed_day: day,
    pricing_hash: pricingHash(pricing),
    pricing_json: JSON.stringify(pricing),
    price_prompt: str(pricing.prompt),
    price_completion: str(pricing.completion),
    price_cache_read: str(pricing.input_cache_read),
    price_cache_write: str(pricing.input_cache_write),
    price_request: str(pricing.request),
    price_web_search: str(pricing.web_search),
    price_internal_reasoning: str(pricing.internal_reasoning),
    has_overrides: Array.isArray(pricing.overrides) && pricing.overrides.length > 0 ? 1 : 0,
    has_sentinel: Object.values(pricing).some(isSentinel) ? 1 : 0,
  };
}

async function fetchCatalog(
  config: Config,
  withAuth: boolean,
): Promise<{ status: number; body: string }> {
  const url = `${config.OPENROUTER_BASE_URL.replace(/\/$/, '')}/api/v1/models`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (withAuth) headers['Authorization'] = `Bearer ${config.OPENROUTER_API_KEY}`;

  const res = await undiciRequest(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(config.BILLING_PRICE_SYNC_TIMEOUT_MS),
  });
  const body = await readBodyWithLimit(res.body, config.BILLING_PRICE_BODY_LIMIT_BYTES);
  return { status: res.statusCode, body };
}

/**
 * Один прогон синхронизации. Наружу не бросает никогда: сбой прайса не должен влиять на
 * проксирование, а сам факт неудачи фиксируется строкой в price_sync_runs.
 */
export async function runPriceSync(deps: PriceSyncDeps): Promise<PriceSyncResult> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const day = billingDay(startedAt, deps.config.BILLING_TIMEZONE);

  const fail = (httpStatus: number | null, error: string): PriceSyncResult => {
    deps.billing.recordSyncRun({
      run_day: day,
      started_at: startedAt,
      finished_at: now(),
      ok: 0,
      models_seen: null,
      versions_written: null,
      http_status: httpStatus,
      error: error.slice(0, 500),
    });
    deps.logger.warn({ day, httpStatus, error }, 'price_sync failed');
    return { ok: false, day, modelsSeen: 0, versionsWritten: 0, httpStatus, error };
  };

  try {
    let res = await fetchCatalog(deps.config, true);
    // Каталог фактически публичный. Если ключ протух, синхронизация цен всё равно должна
    // работать — иначе учёт слепнет ровно тогда, когда с оплатой уже что-то не так.
    if (res.status === 401 || res.status === 403) {
      deps.logger.warn({ status: res.status }, 'price_sync: retrying models catalog without auth');
      res = await fetchCatalog(deps.config, false);
    }
    if (res.status < 200 || res.status >= 300) {
      return fail(res.status, `unexpected status ${res.status}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch (err) {
      return fail(res.status, `invalid json: ${(err as Error).message}`);
    }

    const envelope = modelsResponseSchema.safeParse(parsed);
    if (!envelope.success) return fail(res.status, 'response has no data[] array');

    const versions: PriceVersionInput[] = [];
    let skipped = 0;
    // Поэлементная валидация: одна битая запись каталога не должна ронять весь прогон.
    for (const raw of envelope.data.data) {
      const entry = modelEntrySchema.safeParse(raw);
      if (!entry.success || !entry.data.pricing) {
        skipped += 1;
        continue;
      }
      versions.push(toVersion(entry.data.id, entry.data.pricing, startedAt, day));
    }

    const versionsWritten = deps.billing.upsertPriceVersions(versions);
    deps.billing.recordSyncRun({
      run_day: day,
      started_at: startedAt,
      finished_at: now(),
      ok: 1,
      models_seen: versions.length,
      versions_written: versionsWritten,
      http_status: res.status,
      error: null,
    });
    deps.logger.info(
      { day, modelsSeen: versions.length, versionsWritten, skipped },
      'price_sync completed',
    );
    return {
      ok: true,
      day,
      modelsSeen: versions.length,
      versionsWritten,
      httpStatus: res.status,
    };
  } catch (err) {
    return fail(null, sanitizeErrorForLog(err).message);
  }
}

const TICK_MS = 60_000;
const STARTUP_DELAY_MS = 15_000;
const RETRY_BACKOFF_MS = 60 * 60_000;

/**
 * Планировщик. Условие срабатывания сформулировано не как «ровно в HH:00», а как
 * «за сегодня нет успешной синхронизации и уже позже часа H». Одно правило закрывает
 * разом: догон после рестарта, пропущенные сутки (простой сервиса) и повторный запуск
 * в течение дня (второй раз не сработает).
 */
export function startPriceSyncScheduler(deps: PriceSyncDeps): () => void {
  if (!deps.config.BILLING_PRICE_SYNC_ENABLED) return () => {};

  const now = deps.now ?? Date.now;
  let inFlight = false;
  let nextAttemptAt = 0;

  const tick = (): void => {
    if (inFlight) return;
    const ts = now();
    if (ts < nextAttemptAt) return;
    if (billingHour(ts, deps.config.BILLING_TIMEZONE) < deps.config.BILLING_PRICE_SYNC_HOUR) return;
    const day = billingDay(ts, deps.config.BILLING_TIMEZONE);
    if (deps.billing.hasSuccessfulSyncForDay(day)) return;

    inFlight = true;
    runPriceSync(deps)
      .then((r) => {
        // Неудача — повтор через час, а не долбёжка раз в минуту.
        if (!r.ok) nextAttemptAt = now() + RETRY_BACKOFF_MS;
      })
      .catch((err: unknown) => {
        deps.logger.warn({ err: sanitizeErrorForLog(err) }, 'price_sync scheduler error');
        nextAttemptAt = now() + RETRY_BACKOFF_MS;
      })
      .finally(() => {
        inFlight = false;
      });
  };

  // Не ходим в сеть прямо в момент старта — даём сервису подняться.
  const startupTimer = setTimeout(tick, STARTUP_DELAY_MS);
  startupTimer.unref?.();
  const interval = setInterval(tick, TICK_MS);
  interval.unref?.();

  return () => {
    clearTimeout(startupTimer);
    clearInterval(interval);
  };
}

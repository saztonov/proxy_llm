import type Database from 'better-sqlite3';

/**
 * Репозиторий денежного учёта.
 *
 * Отдельно от RequestsRepo сознательно: тот отвечает за горячий путь записи журнала
 * HTTP-запросов и оперативные счётчики, здесь — ledger фактических обращений к OpenRouter
 * и история цен. Денежные агрегаты считаются ТОЛЬКО по billing_attempts: в requests лежат
 * входящие HTTP-запросы, среди которых есть dedup-join'ы, не порождающие списаний.
 */

export type UsageSource = 'response' | 'missing';
export type EstQuality = 'ok' | 'partial' | 'no_price' | 'unpriceable';

export interface BillingAttemptRecord {
  execution_id: string;
  attempt_no: number;
  request_id: string;
  client_id: string | null;
  /** 'global' — общий ключ OpenRouter; иначе clientId владельца пер-клиентского ключа. */
  payer_scope: string;
  /** Первые 16 hex от sha256 использованного ключа: различает аккаунты и переживает ротацию. */
  api_key_fp: string | null;
  ts_started: number;
  ts_completed: number;
  billing_day: string;
  http_status: number | null;
  classification: string;
  model_requested: string | null;
  model_used: string | null;
  upstream_id: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cached_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd: number | null;
  upstream_inference_cost_usd: number | null;
  is_byok: number | null;
  usage_source: UsageSource;
  cost_est_usd: number | null;
  est_quality: EstQuality | null;
  est_price_version: number | null;
  usage_json: string | null;
}

/**
 * Версия цены модели. Цены — строки ровно как в каталоге OpenRouter: значения вида 5e-9
 * при парсинге в число теряют точность представления, а для истории важно сохранить
 * опубликованное значение дословно. В число превращаются только в момент оценки.
 */
export interface PriceVersionInput {
  model_id: string;
  observed_at: number;
  observed_day: string;
  pricing_hash: string;
  pricing_json: string;
  price_prompt: string | null;
  price_completion: string | null;
  price_cache_read: string | null;
  price_cache_write: string | null;
  price_request: string | null;
  price_web_search: string | null;
  price_internal_reasoning: string | null;
  has_overrides: number;
  has_sentinel: number;
}

export interface PriceVersionRow extends PriceVersionInput {
  id: number;
}

export interface SyncRunInput {
  run_day: string;
  started_at: number;
  finished_at: number | null;
  ok: number;
  models_seen: number | null;
  versions_written: number | null;
  http_status: number | null;
  error: string | null;
}

export interface SyncRunRow extends SyncRunInput {
  id: number;
}

export interface SpendTotals {
  upstream_attempts: number;
  executions: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  /** Измеренный расход: сумма usage.cost. Единственное, что можно нести в бухгалтерию. */
  cost_actual_usd: number;
  /** Каталожная оценка ТОЛЬКО для попыток без факта. Диагностика, не факт. */
  cost_approx_usd: number;
  /** Попытки без cost и без пригодной оценки — дыра покрытия, её надо видеть. */
  missing_rows: number;
  approx_rows: number;
}

export interface DayClientSpendRow extends SpendTotals {
  billing_day: string;
  client_id: string | null;
}

export interface ClientSpendRow extends SpendTotals {
  client_id: string | null;
}

export interface ModelSpendRow extends SpendTotals {
  model: string | null;
}

/**
 * Общие агрегаты. usage_source='response' → факт; иначе в дело идёт оценка, но в отдельную
 * колонку. Строка попадает в missing_rows, только если нет ни факта, ни оценки.
 */
const SPEND_COLUMNS = `
  COUNT(*)                                  AS upstream_attempts,
  COUNT(DISTINCT execution_id)              AS executions,
  COALESCE(SUM(prompt_tokens), 0)           AS input_tokens,
  COALESCE(SUM(completion_tokens), 0)       AS output_tokens,
  COALESCE(SUM(cached_tokens), 0)           AS cached_tokens,
  COALESCE(SUM(reasoning_tokens), 0)        AS reasoning_tokens,
  COALESCE(SUM(CASE WHEN usage_source = 'response' THEN cost_usd ELSE 0 END), 0.0)
                                            AS cost_actual_usd,
  COALESCE(SUM(CASE WHEN usage_source <> 'response' THEN COALESCE(cost_est_usd, 0) ELSE 0 END), 0.0)
                                            AS cost_approx_usd,
  SUM(CASE WHEN usage_source <> 'response' AND cost_est_usd IS NULL THEN 1 ELSE 0 END)
                                            AS missing_rows,
  SUM(CASE WHEN usage_source <> 'response' AND cost_est_usd IS NOT NULL THEN 1 ELSE 0 END)
                                            AS approx_rows
`;

const SPEND_WHERE = `WHERE billing_day >= ? AND billing_day <= ?`;

export class BillingRepo {
  private readonly insertAttemptStmt;
  private readonly metaGetStmt;
  private readonly latestPriceStmt;
  private readonly priceAtStmt;
  private readonly insertPriceStmt;
  private readonly insertSyncRunStmt;
  private readonly lastOkSyncStmt;
  private readonly hasOkSyncForDayStmt;
  private readonly spendByDayClientStmt;
  private readonly spendByClientStmt;
  private readonly spendByModelStmt;
  private readonly spendTotalsStmt;
  private readonly retryWasteStmt;

  constructor(private readonly db: Database.Database) {
    // ON CONFLICT DO NOTHING по (execution_id, attempt_no): повторная запись того же
    // наблюдения не должна ни падать, ни задваивать расход.
    this.insertAttemptStmt = db.prepare<BillingAttemptRecord>(`
      INSERT INTO billing_attempts (
        execution_id, attempt_no, request_id, client_id, payer_scope, api_key_fp,
        ts_started, ts_completed, billing_day,
        http_status, classification,
        model_requested, model_used, upstream_id,
        prompt_tokens, completion_tokens, total_tokens,
        cached_tokens, cache_write_tokens, reasoning_tokens,
        cost_usd, upstream_inference_cost_usd, is_byok, usage_source,
        cost_est_usd, est_quality, est_price_version, usage_json
      ) VALUES (
        @execution_id, @attempt_no, @request_id, @client_id, @payer_scope, @api_key_fp,
        @ts_started, @ts_completed, @billing_day,
        @http_status, @classification,
        @model_requested, @model_used, @upstream_id,
        @prompt_tokens, @completion_tokens, @total_tokens,
        @cached_tokens, @cache_write_tokens, @reasoning_tokens,
        @cost_usd, @upstream_inference_cost_usd, @is_byok, @usage_source,
        @cost_est_usd, @est_quality, @est_price_version, @usage_json
      )
      ON CONFLICT(execution_id, attempt_no) DO NOTHING
    `);

    this.metaGetStmt = db.prepare<[string]>(`SELECT value FROM billing_meta WHERE key = ?`);

    this.latestPriceStmt = db.prepare<[string]>(`
      SELECT * FROM model_price_versions
      WHERE model_id = ?
      ORDER BY observed_at DESC, id DESC
      LIMIT 1
    `);

    // «Цена, действовавшая на момент X» = последняя версия, наблюдённая НЕ ПОЗЖЕ X.
    // Ведущая колонка индекса — model_id, поэтому запрос не сканирует таблицу.
    this.priceAtStmt = db.prepare<[string, number]>(`
      SELECT * FROM model_price_versions
      WHERE model_id = ? AND observed_at <= ?
      ORDER BY observed_at DESC, id DESC
      LIMIT 1
    `);

    this.insertPriceStmt = db.prepare<PriceVersionInput>(`
      INSERT INTO model_price_versions (
        model_id, observed_at, observed_day, pricing_hash, pricing_json,
        price_prompt, price_completion, price_cache_read, price_cache_write,
        price_request, price_web_search, price_internal_reasoning,
        has_overrides, has_sentinel
      ) VALUES (
        @model_id, @observed_at, @observed_day, @pricing_hash, @pricing_json,
        @price_prompt, @price_completion, @price_cache_read, @price_cache_write,
        @price_request, @price_web_search, @price_internal_reasoning,
        @has_overrides, @has_sentinel
      )
    `);

    this.insertSyncRunStmt = db.prepare<SyncRunInput>(`
      INSERT INTO price_sync_runs (
        run_day, started_at, finished_at, ok, models_seen, versions_written, http_status, error
      ) VALUES (
        @run_day, @started_at, @finished_at, @ok, @models_seen, @versions_written, @http_status, @error
      )
    `);

    this.lastOkSyncStmt = db.prepare(`
      SELECT * FROM price_sync_runs WHERE ok = 1 ORDER BY started_at DESC, id DESC LIMIT 1
    `);

    this.hasOkSyncForDayStmt = db.prepare<[string]>(`
      SELECT 1 FROM price_sync_runs WHERE run_day = ? AND ok = 1 LIMIT 1
    `);

    // billing_day — хранимая индексированная колонка, поэтому фильтр по периоду идёт по
    // индексу, а не через вычисление даты на каждой строке.
    this.spendByDayClientStmt = db.prepare<[string, string]>(`
      SELECT billing_day, client_id, ${SPEND_COLUMNS}
      FROM billing_attempts ${SPEND_WHERE}
      GROUP BY billing_day, client_id
      ORDER BY billing_day DESC, cost_actual_usd DESC
    `);

    this.spendByClientStmt = db.prepare<[string, string]>(`
      SELECT client_id, ${SPEND_COLUMNS}
      FROM billing_attempts ${SPEND_WHERE}
      GROUP BY client_id
      ORDER BY cost_actual_usd DESC
    `);

    this.spendByModelStmt = db.prepare<[string, string]>(`
      SELECT COALESCE(model_used, model_requested) AS model, ${SPEND_COLUMNS}
      FROM billing_attempts ${SPEND_WHERE}
      GROUP BY model
      ORDER BY cost_actual_usd DESC
    `);

    this.spendTotalsStmt = db.prepare<[string, string]>(`
      SELECT ${SPEND_COLUMNS} FROM billing_attempts ${SPEND_WHERE}
    `);

    this.retryWasteStmt = db.prepare<[string, string]>(`
      SELECT COALESCE(SUM(cost_usd), 0.0) AS waste
      FROM billing_attempts a
      ${SPEND_WHERE}
        AND EXISTS (
          SELECT 1 FROM billing_attempts b
          WHERE b.execution_id = a.execution_id AND b.attempt_no > a.attempt_no
        )
    `);
  }

  insertAttempt(record: BillingAttemptRecord): void {
    this.insertAttemptStmt.run(record);
  }

  latestPriceVersion(modelId: string): PriceVersionRow | null {
    return (this.latestPriceStmt.get(modelId) as PriceVersionRow | undefined) ?? null;
  }

  priceVersionAt(modelId: string, tsMs: number): PriceVersionRow | null {
    return (this.priceAtStmt.get(modelId, tsMs) as PriceVersionRow | undefined) ?? null;
  }

  /**
   * Пишет только изменившиеся цены: новая версия появляется, когда pricing_hash отличается
   * от последнего известного. Каталог из ~400 моделей меняется редко, поэтому история
   * остаётся компактной и хранится бессрочно. Факт проверки неизменившегося прайса
   * фиксирует price_sync_runs.
   */
  upsertPriceVersions(versions: PriceVersionInput[]): number {
    const run = this.db.transaction((rows: PriceVersionInput[]) => {
      let written = 0;
      for (const row of rows) {
        const latest = this.latestPriceVersion(row.model_id);
        if (latest && latest.pricing_hash === row.pricing_hash) continue;
        this.insertPriceStmt.run(row);
        written += 1;
      }
      return written;
    });
    return run(versions);
  }

  recordSyncRun(run: SyncRunInput): void {
    this.insertSyncRunStmt.run(run);
  }

  lastSuccessfulSync(): SyncRunRow | null {
    return (this.lastOkSyncStmt.get() as SyncRunRow | undefined) ?? null;
  }

  hasSuccessfulSyncForDay(day: string): boolean {
    return this.hasOkSyncForDayStmt.get(day) !== undefined;
  }

  /**
   * Расход по суткам × клиентам.
   *
   * Факт (cost_actual_usd) и оценка (cost_approx_usd) НИКОГДА не складываются в одно число:
   * иначе по итогу невозможно понять, сколько в нём измеренного. Оценка живёт отдельной
   * колонкой и в отчётах показывается с пометкой «≈».
   */
  spendByDayClient(fromDay: string, toDay: string): DayClientSpendRow[] {
    return this.spendByDayClientStmt.all(fromDay, toDay) as DayClientSpendRow[];
  }

  spendByClient(fromDay: string, toDay: string): ClientSpendRow[] {
    return this.spendByClientStmt.all(fromDay, toDay) as ClientSpendRow[];
  }

  spendByModel(fromDay: string, toDay: string): ModelSpendRow[] {
    return this.spendByModelStmt.all(fromDay, toDay) as ModelSpendRow[];
  }

  /** Сводка за период целиком (для карточек «сегодня / вчера / 30 суток»). */
  spendTotals(fromDay: string, toDay: string): SpendTotals {
    return this.spendTotalsStmt.get(fromDay, toDay) as SpendTotals;
  }

  /**
   * Стоимость попыток, отброшенных ретраем: генерация оплачена, а результат не отдан клиенту.
   * Ровно эта сумма объясняет часть расхождения с инвойсом OpenRouter.
   */
  retryWasteUsd(fromDay: string, toDay: string): number {
    const row = this.retryWasteStmt.get(fromDay, toDay) as { waste: number };
    return row.waste;
  }

  getMeta(key: string): string | null {
    const row = this.metaGetStmt.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Момент, с которого денежный учёт достоверен (до него стоимости в журнале нет). */
  accountingStartedAt(): number | null {
    const raw = this.getMeta('accounting_started_at');
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
}

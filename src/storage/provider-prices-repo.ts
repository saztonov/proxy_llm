import type Database from 'better-sqlite3';
import { parseStoredPrice, type ProviderPrice } from '../billing/provider-pricing.js';

export interface ProviderPriceRow {
  id: number;
  provider_id: number;
  model: string;
  /** С какого момента (мс) действует цена; 0 — для всей истории. */
  effective_from: number;
  price_json: string;
  created_at: number;
  created_by: number | null;
}

export interface ProviderPriceVersion {
  id: number;
  providerId: number;
  model: string;
  effectiveFrom: number;
  price: ProviderPrice;
  createdAt: number;
}

/** Строка журнала попыток, которую нужно переоценить после смены цены. */
export interface RepriceRow {
  id: number;
  ts_started: number;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  cache_write_tokens: number | null;
}

function toVersion(r: ProviderPriceRow): ProviderPriceVersion | null {
  const price = parseStoredPrice(r.price_json);
  if (!price) return null;
  return { id: r.id, providerId: r.provider_id, model: r.model, effectiveFrom: r.effective_from, price, createdAt: r.created_at };
}

/**
 * Цены моделей провайдеров агентского контура (см. billing/provider-pricing.ts).
 *
 * Цена не редактируется на месте: каждое сохранение — новая версия со своим effective_from.
 * Попытка оценивается по версии, действовавшей в момент её начала, поэтому смена прайса
 * «с завтрашнего дня» не переписывает вчерашние расходы.
 */
export class ProviderPricesRepo {
  private readonly insertStmt;
  private readonly atStmt;
  private readonly latestStmt;
  private readonly idsStmt;
  private readonly deleteStmt;
  private readonly repriceRowsStmt;
  private readonly setEstimateStmt;
  private readonly clearEstimatesStmt;
  private readonly usedModelsStmt;

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO provider_model_prices (provider_id, model, effective_from, price_json, created_at, created_by)
      VALUES (@provider_id, @model, @effective_from, @price_json, @now, @created_by)
    `);
    this.atStmt = db.prepare(`
      SELECT * FROM provider_model_prices
      WHERE provider_id = ? AND model = ? AND effective_from <= ?
      ORDER BY effective_from DESC, id DESC LIMIT 1
    `);
    // Последняя сохранённая версия каждой модели — то, что видит админ.
    this.latestStmt = db.prepare(`
      SELECT p.* FROM provider_model_prices p
      WHERE p.provider_id = ? AND p.id = (
        SELECT MAX(id) FROM provider_model_prices q WHERE q.provider_id = p.provider_id AND q.model = p.model
      )
      ORDER BY p.model
    `);
    this.idsStmt = db.prepare(`SELECT id FROM provider_model_prices WHERE provider_id = ? AND model = ?`);
    this.deleteStmt = db.prepare(`DELETE FROM provider_model_prices WHERE provider_id = ? AND model = ?`);
    // Факт из ответа (usage_source='response') не трогаем: оценка нужна только там, где его нет.
    this.repriceRowsStmt = db.prepare(`
      SELECT id, ts_started, prompt_tokens, completion_tokens, cached_tokens, cache_write_tokens
      FROM billing_attempts
      WHERE contour = 'agent' AND provider_id = ? AND model_requested = ? AND ts_started >= ?
        AND usage_source <> 'response'
    `);
    this.setEstimateStmt = db.prepare(`
      UPDATE billing_attempts SET cost_est_usd = ?, est_quality = ?, est_provider_price_id = ? WHERE id = ?
    `);
    this.clearEstimatesStmt = db.prepare(`
      UPDATE billing_attempts SET cost_est_usd = NULL, est_quality = 'no_price', est_provider_price_id = NULL
      WHERE contour = 'agent' AND provider_id = ? AND model_requested = ? AND usage_source <> 'response'
    `);
    // Модели, под которые цена реально пригодится: по ним были запросы или их назначили ключам.
    this.usedModelsStmt = db.prepare(`
      SELECT model FROM (
        SELECT DISTINCT model_requested AS model FROM billing_attempts
        WHERE contour = 'agent' AND provider_id = @id AND model_requested IS NOT NULL
        UNION
        SELECT model FROM agent_tokens WHERE provider_id = @id AND model IS NOT NULL AND revoked_at IS NULL
      ) ORDER BY model
    `);
  }

  insert(input: { provider_id: number; model: string; effective_from: number; price: ProviderPrice; created_by: number | null }, now: number): number {
    const r = this.insertStmt.run({
      provider_id: input.provider_id,
      model: input.model,
      effective_from: input.effective_from,
      price_json: JSON.stringify(input.price),
      created_by: input.created_by,
      now,
    });
    return Number(r.lastInsertRowid);
  }

  /** Цена, действовавшая для модели в момент ts; нет или запись битая — null. */
  priceAt(providerId: number, model: string, ts: number): ProviderPriceVersion | null {
    const row = this.atStmt.get(providerId, model, ts) as ProviderPriceRow | undefined;
    return row ? toVersion(row) : null;
  }

  listLatest(providerId: number): ProviderPriceVersion[] {
    return (this.latestStmt.all(providerId) as ProviderPriceRow[])
      .map(toVersion)
      .filter((v): v is ProviderPriceVersion => v !== null);
  }

  /** Удаляет все версии цены модели. Возвращает число удалённых версий. */
  deleteModel(providerId: number, model: string): number {
    const n = (this.idsStmt.all(providerId, model) as Array<{ id: number }>).length;
    this.deleteStmt.run(providerId, model);
    return n;
  }

  repriceRows(providerId: number, model: string, fromTs: number): RepriceRow[] {
    return this.repriceRowsStmt.all(providerId, model, fromTs) as RepriceRow[];
  }

  setEstimate(attemptId: number, usd: number | null, quality: string, priceId: number | null): void {
    this.setEstimateStmt.run(usd, quality, priceId, attemptId);
  }

  /** Снимает оценки модели (цена удалена). Возвращает число затронутых попыток. */
  clearEstimates(providerId: number, model: string): number {
    return this.clearEstimatesStmt.run(providerId, model).changes;
  }

  /** Модели провайдера из журнала запросов и назначений ключей (без глобального дефолта). */
  usedModels(providerId: number): string[] {
    return (this.usedModelsStmt.all({ id: providerId }) as Array<{ model: string }>).map((r) => r.model);
  }
}

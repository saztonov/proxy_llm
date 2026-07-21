import type Database from 'better-sqlite3';

export type RequestStatus =
  | 'success'
  | 'body_level_error'
  | 'malformed_success'
  | 'upstream_error'
  | 'upstream_response_too_large'
  | 'timeout'
  | 'deadline_exceeded'
  | 'rejected'
  | 'failed_after_restart';

export interface RequestRecord {
  request_id: string;
  idempotency_key: string | null;
  upstream_id: string | null;
  ts_received: number;
  ts_completed: number | null;
  model_used: string | null;
  fallback_used: number | null;
  status: RequestStatus;
  http_status: number | null;
  latency_ms: number | null;
  request_bytes: number | null;
  response_bytes: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  attempt_count: number;
  retry_after_seconds: number | null;
  error_code: string | null;
  error_msg: string | null;
  client_ip: string | null;
  source: string;
  client_id: string | null;
  /** Связка с ledger'ом billing_attempts. Денег в этой таблице нет. */
  billing_execution_id?: string | null;
  /** 1 — запрос присоединился к чужому выполнению по X-Idempotency-Key: своего списания нет. */
  dedup_join?: number;
  model_requested?: string | null;
}

/** RequestRecord с разрешёнными опциональными полями — ровно то, что уходит в bind. */
type RequestRow = Omit<
  RequestRecord,
  'billing_execution_id' | 'dedup_join' | 'model_requested'
> & {
  billing_execution_id: string | null;
  dedup_join: number;
  model_requested: string | null;
};

export interface AggregateRow {
  total: number;
  success: number;
  errors: number;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
  total_tokens: number | null;
}

export interface DashboardRow {
  id: number;
  request_id: string;
  ts_received: number;
  ts_completed: number | null;
  model_used: string | null;
  status: RequestStatus;
  http_status: number | null;
  latency_ms: number | null;
  total_tokens: number | null;
  upstream_id: string | null;
  error_code: string | null;
  client_id: string | null;
  /** 1 — присоединился к чужому выполнению: результат общий, отдельного списания нет. */
  dedup_join: number;
  /** Агрегаты по ledger'у выполнения; NULL, если попыток ещё нет (запись до-биллинговая). */
  input_tokens: number | null;
  output_tokens: number | null;
  cost_actual_usd: number | null;
  missing_attempts: number | null;
}

export interface PerClientRow {
  client_id: string | null;
  total: number;
  errors: number;
  total_tokens: number | null;
}

export interface ErrorBreakdownRow {
  status: RequestStatus;
  error_code: string | null;
  n: number;
}

export class RequestsRepo {
  private readonly insertStmt;
  private readonly listRecentStmt;
  private readonly aggregateStmt;
  private readonly aggregateClientStmt;
  private readonly perClientStmt;
  private readonly errorBreakdownStmt;
  private readonly recentStatusStmt;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare<RequestRow>(`
      INSERT INTO requests (
        request_id, idempotency_key, upstream_id,
        ts_received, ts_completed,
        model_used, fallback_used,
        status, http_status, latency_ms,
        request_bytes, response_bytes,
        prompt_tokens, completion_tokens, total_tokens,
        attempt_count, retry_after_seconds,
        error_code, error_msg,
        client_ip, source, client_id,
        billing_execution_id, dedup_join, model_requested
      ) VALUES (
        @request_id, @idempotency_key, @upstream_id,
        @ts_received, @ts_completed,
        @model_used, @fallback_used,
        @status, @http_status, @latency_ms,
        @request_bytes, @response_bytes,
        @prompt_tokens, @completion_tokens, @total_tokens,
        @attempt_count, @retry_after_seconds,
        @error_code, @error_msg,
        @client_ip, @source, @client_id,
        @billing_execution_id, @dedup_join, @model_requested
      )
    `);

    // Коррелированные подзапросы вместо join с агрегатом по всей таблице: выбирается сотня
    // строк, и каждая подтягивает свои попытки по индексу idx_ba_exec.
    this.listRecentStmt = db.prepare<[number]>(`
      SELECT r.id, r.request_id, r.ts_received, r.ts_completed, r.model_used,
             r.status, r.http_status, r.latency_ms, r.total_tokens, r.upstream_id,
             r.error_code, r.client_id, r.dedup_join,
             (SELECT SUM(prompt_tokens) FROM billing_attempts b
                WHERE b.execution_id = r.billing_execution_id) AS input_tokens,
             (SELECT SUM(completion_tokens) FROM billing_attempts b
                WHERE b.execution_id = r.billing_execution_id) AS output_tokens,
             (SELECT SUM(CASE WHEN usage_source = 'response' THEN cost_usd ELSE 0 END)
                FROM billing_attempts b
                WHERE b.execution_id = r.billing_execution_id) AS cost_actual_usd,
             (SELECT SUM(CASE WHEN usage_source <> 'response' THEN 1 ELSE 0 END)
                FROM billing_attempts b
                WHERE b.execution_id = r.billing_execution_id) AS missing_attempts
      FROM requests r
      ORDER BY r.id DESC
      LIMIT ?
    `);

    this.aggregateStmt = db.prepare<[number]>(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS errors,
        AVG(latency_ms) AS avg_latency_ms,
        NULL AS p95_latency_ms,
        SUM(total_tokens) AS total_tokens
      FROM requests
      WHERE ts_received >= ?
    `);

    this.aggregateClientStmt = db.prepare<[number, string]>(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS errors,
        AVG(latency_ms) AS avg_latency_ms,
        NULL AS p95_latency_ms,
        SUM(total_tokens) AS total_tokens
      FROM requests
      WHERE ts_received >= ? AND client_id = ?
    `);

    this.perClientStmt = db.prepare<[number]>(`
      SELECT
        client_id,
        COUNT(*) AS total,
        SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS errors,
        SUM(total_tokens) AS total_tokens
      FROM requests
      WHERE ts_received >= ?
      GROUP BY client_id
      ORDER BY total DESC
    `);

    // Разбивка ошибок по типу за период (для дневного дайджеста). Без client_id —
    // совместимо со схемой до мультитенантности.
    this.errorBreakdownStmt = db.prepare<[number]>(`
      SELECT status, error_code, COUNT(*) AS n
      FROM requests
      WHERE ts_received >= ? AND status != 'success'
      GROUP BY status, error_code
      ORDER BY n DESC
    `);

    this.recentStatusStmt = db.prepare<[number]>(`
      SELECT status FROM requests ORDER BY id DESC LIMIT ?
    `);
  }

  insert(record: RequestRecord): void {
    this.insertStmt.run(RequestsRepo.toRow(record));
  }

  /**
   * Явный маппинг вместо спреда с дефолтами: better-sqlite3 падает на named-параметре со
   * значением undefined, а `{...defaults, ...record}` именно undefined и пропускает внутрь,
   * если ключ присутствует в объекте. Поэтому каждое опциональное поле приводится через `?? null`.
   */
  private static toRow(r: RequestRecord): RequestRow {
    return {
      ...r,
      billing_execution_id: r.billing_execution_id ?? null,
      dedup_join: r.dedup_join ?? 0,
      model_requested: r.model_requested ?? null,
    };
  }

  listRecent(limit: number): DashboardRow[] {
    return this.listRecentStmt.all(limit) as DashboardRow[];
  }

  aggregateSince(tsMs: number, clientId?: string): AggregateRow {
    if (clientId !== undefined) {
      return this.aggregateClientStmt.get(tsMs, clientId) as AggregateRow;
    }
    return this.aggregateStmt.get(tsMs) as AggregateRow;
  }

  /** Пер-клиентская сводка за период (для дашборда/статистики). */
  perClientAggregate(tsMs: number): PerClientRow[] {
    return this.perClientStmt.all(tsMs) as PerClientRow[];
  }

  /** Разбивка ошибок (status != 'success') по status/error_code за период. */
  errorBreakdownSince(tsMs: number): ErrorBreakdownRow[] {
    return this.errorBreakdownStmt.all(tsMs) as ErrorBreakdownRow[];
  }

  /** Берёт latency значений из последних N успешных запросов и считает p95 локально. */
  p95LatencySince(tsMs: number, limit = 500): number | null {
    const rows = this.db
      .prepare<[number, number]>(
        `SELECT latency_ms FROM requests
         WHERE ts_received >= ? AND latency_ms IS NOT NULL
         ORDER BY id DESC LIMIT ?`,
      )
      .all(tsMs, limit) as { latency_ms: number }[];
    if (rows.length === 0) return null;
    const sorted = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[Math.min(idx, sorted.length - 1)] ?? null;
  }

  recentStatuses(limit: number): RequestStatus[] {
    const rows = this.recentStatusStmt.all(limit) as { status: RequestStatus }[];
    return rows.map((r) => r.status);
  }
}

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
}

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
    this.insertStmt = db.prepare<RequestRecord>(`
      INSERT INTO requests (
        request_id, idempotency_key, upstream_id,
        ts_received, ts_completed,
        model_used, fallback_used,
        status, http_status, latency_ms,
        request_bytes, response_bytes,
        prompt_tokens, completion_tokens, total_tokens,
        attempt_count, retry_after_seconds,
        error_code, error_msg,
        client_ip, source, client_id
      ) VALUES (
        @request_id, @idempotency_key, @upstream_id,
        @ts_received, @ts_completed,
        @model_used, @fallback_used,
        @status, @http_status, @latency_ms,
        @request_bytes, @response_bytes,
        @prompt_tokens, @completion_tokens, @total_tokens,
        @attempt_count, @retry_after_seconds,
        @error_code, @error_msg,
        @client_ip, @source, @client_id
      )
    `);

    this.listRecentStmt = db.prepare<[number]>(`
      SELECT id, request_id, ts_received, ts_completed, model_used,
             status, http_status, latency_ms, total_tokens, upstream_id, error_code, client_id
      FROM requests
      ORDER BY id DESC
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
    this.insertStmt.run(record);
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

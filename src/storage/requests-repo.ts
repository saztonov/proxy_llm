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
  | 'failed_after_restart'
  // Агентский контур (стриминг):
  /** Клиент сам оборвал соединение (отмена в IDE) — не ошибка прокси и не ошибка провайдера. */
  | 'client_aborted'
  /** Провайдер прислал error-событие посреди уже начатого стрима. */
  | 'stream_upstream_error'
  /** Поток закончился без [DONE] и без error-события: ответ, возможно, обрезан. */
  | 'stream_incomplete';

/** Контур: сайты (порталы, /api/v1) или AI-агенты сотрудников (/agent/v1). */
export type Contour = 'site' | 'agent';

/**
 * Статусы, которые не считаются ошибками ни в сводках, ни в error-rate алерте. Отмена запроса
 * пользователем в IDE — нормальный сценарий агентов; считать её ошибкой значило бы будить
 * дежурного каждый раз, когда кто-то нажал «стоп».
 */
export const NON_ERROR_STATUSES: ReadonlySet<RequestStatus> = new Set<RequestStatus>(['success', 'client_aborted']);
const NON_ERROR_SQL = `('success', 'client_aborted')`;

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
  /** По умолчанию 'site' — вся история до агентского контура. */
  contour?: Contour;
  /** site_tokens.id или agent_tokens.id (по contour); NULL — токен не из БД. */
  token_id?: number | null;
  department_id?: number | null;
  employee_id?: number | null;
}

type OptionalKeys =
  | 'billing_execution_id' | 'dedup_join' | 'model_requested'
  | 'contour' | 'token_id' | 'department_id' | 'employee_id';

/** RequestRecord с разрешёнными опциональными полями — ровно то, что уходит в bind. */
type RequestRow = Omit<RequestRecord, OptionalKeys> & {
  billing_execution_id: string | null;
  dedup_join: number;
  model_requested: string | null;
  contour: Contour;
  token_id: number | null;
  department_id: number | null;
  employee_id: number | null;
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
  model_requested: string | null;
  status: RequestStatus;
  http_status: number | null;
  latency_ms: number | null;
  total_tokens: number | null;
  upstream_id: string | null;
  error_code: string | null;
  client_id: string | null;
  contour: Contour;
  token_id: number | null;
  department_id: number | null;
  employee_id: number | null;
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

export interface RecentFilter {
  limit: number;
  contour?: Contour;
  clientId?: string;
  tokenId?: number;
  departmentId?: number;
  employeeId?: number;
}

/** Фильтр по контуру для запросов с named-параметром @contour (NULL — все контуры). */
const CONTOUR_FILTER = `(@contour IS NULL OR contour = @contour)`;

export class RequestsRepo {
  private readonly insertStmt;
  private readonly listRecentStmt;
  private readonly aggregateStmt;
  private readonly perClientStmt;
  private readonly errorBreakdownStmt;
  private readonly recentStatusStmt;
  private readonly p95Stmt;

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(`
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
        billing_execution_id, dedup_join, model_requested,
        contour, token_id, department_id, employee_id
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
        @billing_execution_id, @dedup_join, @model_requested,
        @contour, @token_id, @department_id, @employee_id
      )
    `);

    // Коррелированные подзапросы вместо join с агрегатом по всей таблице: выбирается сотня
    // строк, и каждая подтягивает свои попытки по индексу idx_ba_exec.
    this.listRecentStmt = db.prepare(`
      SELECT r.id, r.request_id, r.ts_received, r.ts_completed, r.model_used, r.model_requested,
             r.status, r.http_status, r.latency_ms, r.total_tokens, r.upstream_id,
             r.error_code, r.client_id, r.contour, r.token_id, r.department_id, r.employee_id,
             r.dedup_join,
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
      WHERE (@contour IS NULL OR r.contour = @contour)
        AND (@clientId IS NULL OR r.client_id = @clientId)
        AND (@tokenId IS NULL OR r.token_id = @tokenId)
        AND (@departmentId IS NULL OR r.department_id = @departmentId)
        AND (@employeeId IS NULL OR r.employee_id = @employeeId)
      ORDER BY r.id DESC
      LIMIT @limit
    `);

    this.aggregateStmt = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status NOT IN ${NON_ERROR_SQL} THEN 1 ELSE 0 END) AS errors,
        AVG(latency_ms) AS avg_latency_ms,
        NULL AS p95_latency_ms,
        SUM(total_tokens) AS total_tokens
      FROM requests
      WHERE ts_received >= @ts AND (@clientId IS NULL OR client_id = @clientId) AND ${CONTOUR_FILTER}
    `);

    this.perClientStmt = db.prepare(`
      SELECT
        client_id,
        COUNT(*) AS total,
        SUM(CASE WHEN status NOT IN ${NON_ERROR_SQL} THEN 1 ELSE 0 END) AS errors,
        SUM(total_tokens) AS total_tokens
      FROM requests
      WHERE ts_received >= @ts AND ${CONTOUR_FILTER}
      GROUP BY client_id
      ORDER BY total DESC
    `);

    // Разбивка ошибок по типу за период (для дневного дайджеста).
    this.errorBreakdownStmt = db.prepare(`
      SELECT status, error_code, COUNT(*) AS n
      FROM requests
      WHERE ts_received >= @ts AND status NOT IN ${NON_ERROR_SQL} AND ${CONTOUR_FILTER}
      GROUP BY status, error_code
      ORDER BY n DESC
    `);

    this.recentStatusStmt = db.prepare(`
      SELECT status FROM requests WHERE ${CONTOUR_FILTER} ORDER BY id DESC LIMIT @limit
    `);

    this.p95Stmt = db.prepare(`
      SELECT latency_ms FROM requests
      WHERE ts_received >= @ts AND latency_ms IS NOT NULL AND ${CONTOUR_FILTER}
      ORDER BY id DESC LIMIT @limit
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
      contour: r.contour ?? 'site',
      token_id: r.token_id ?? null,
      department_id: r.department_id ?? null,
      employee_id: r.employee_id ?? null,
    };
  }

  listRecent(limit: number, contour?: Contour): DashboardRow[] {
    return this.listRecentFiltered(contour ? { limit, contour } : { limit });
  }

  listRecentFiltered(f: RecentFilter): DashboardRow[] {
    return this.listRecentStmt.all({
      limit: f.limit,
      contour: f.contour ?? null,
      clientId: f.clientId ?? null,
      tokenId: f.tokenId ?? null,
      departmentId: f.departmentId ?? null,
      employeeId: f.employeeId ?? null,
    }) as DashboardRow[];
  }

  aggregateSince(tsMs: number, clientId?: string, contour?: Contour): AggregateRow {
    return this.aggregateStmt.get({ ts: tsMs, clientId: clientId ?? null, contour: contour ?? null }) as AggregateRow;
  }

  /** Пер-клиентская сводка за период (для дашборда/статистики). */
  perClientAggregate(tsMs: number, contour?: Contour): PerClientRow[] {
    return this.perClientStmt.all({ ts: tsMs, contour: contour ?? null }) as PerClientRow[];
  }

  /** Разбивка ошибок (всё, кроме success и client_aborted) по status/error_code за период. */
  errorBreakdownSince(tsMs: number, contour?: Contour): ErrorBreakdownRow[] {
    return this.errorBreakdownStmt.all({ ts: tsMs, contour: contour ?? null }) as ErrorBreakdownRow[];
  }

  /** Берёт latency последних N запросов и считает p95 локально. */
  p95LatencySince(tsMs: number, limit = 500, contour?: Contour): number | null {
    const rows = this.p95Stmt.all({ ts: tsMs, limit, contour: contour ?? null }) as { latency_ms: number }[];
    if (rows.length === 0) return null;
    const sorted = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[Math.min(idx, sorted.length - 1)] ?? null;
  }

  recentStatuses(limit: number, contour?: Contour): RequestStatus[] {
    const rows = this.recentStatusStmt.all({ limit, contour: contour ?? null }) as { status: RequestStatus }[];
    return rows.map((r) => r.status);
  }
}

import type Database from 'better-sqlite3';
import { buildUpdate } from './sql-util.js';
import { withConflict } from './errors.js';

export type PrincipalType = 'department' | 'employee';

export interface AgentTokenRow {
  id: number;
  token_sha256: string;
  token_prefix: string;
  label: string;
  principal_type: PrincipalType;
  department_id: number | null;
  employee_id: number | null;
  /** provider_id + model — принудительная модель токена; оба NULL — глобальный дефолт. */
  provider_id: number | null;
  model: string | null;
  allowed_cidrs_json: string | null;
  expires_at: number | null;
  enabled: number;
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}

/** Токен + его эффективный отдел (у токена сотрудника — отдел сотрудника) и лимиты владельцев. */
export interface AgentTokenResolvableRow extends AgentTokenRow {
  eff_department_id: number;
  department_slug: string;
  department_name: string;
  department_max_concurrency: number | null;
  department_max_pending: number | null;
  employee_login: string | null;
  employee_name: string | null;
  employee_max_concurrency: number | null;
  employee_max_pending: number | null;
}

export interface AgentTokenListRow extends AgentTokenRow {
  eff_department_id: number | null;
  department_name: string | null;
  employee_login: string | null;
  employee_name: string | null;
  provider_name: string | null;
}

export type AgentTokenInput = Pick<
  AgentTokenRow,
  | 'token_sha256' | 'token_prefix' | 'label' | 'principal_type' | 'department_id' | 'employee_id'
  | 'provider_id' | 'model' | 'allowed_cidrs_json' | 'expires_at'
>;
export type AgentTokenPatch = Partial<
  Pick<AgentTokenRow, 'label' | 'provider_id' | 'model' | 'allowed_cidrs_json' | 'expires_at' | 'enabled'>
>;

const PATCHABLE = ['label', 'provider_id', 'model', 'allowed_cidrs_json', 'expires_at', 'enabled'] as const;

export interface AgentTokenFilter {
  departmentId?: number;
  employeeId?: number;
  includeRevoked?: boolean;
}

export class AgentTokensRepo {
  private readonly resolvableStmt;
  private readonly listStmt;
  private readonly getStmt;
  private readonly insertStmt;
  private readonly revokeStmt;
  private readonly touchStmt;

  constructor(private readonly db: Database.Database) {
    // Отключение отдела или сотрудника гасит токены без их отзыва: включили обратно — работают.
    this.resolvableStmt = db.prepare(`
      SELECT t.*,
        d.id AS eff_department_id, d.slug AS department_slug, d.name AS department_name,
        d.max_concurrency AS department_max_concurrency, d.max_pending AS department_max_pending,
        e.login AS employee_login, e.display_name AS employee_name,
        e.max_concurrency AS employee_max_concurrency, e.max_pending AS employee_max_pending
      FROM agent_tokens t
      LEFT JOIN employees e ON e.id = t.employee_id
      JOIN departments d ON d.id = COALESCE(t.department_id, e.department_id)
      WHERE t.revoked_at IS NULL AND t.enabled = 1 AND d.enabled = 1
        AND (t.employee_id IS NULL OR e.enabled = 1)
    `);
    this.listStmt = db.prepare(`
      SELECT t.*,
        d.id AS eff_department_id, d.name AS department_name,
        e.login AS employee_login, e.display_name AS employee_name,
        p.name AS provider_name
      FROM agent_tokens t
      LEFT JOIN employees e ON e.id = t.employee_id
      LEFT JOIN departments d ON d.id = COALESCE(t.department_id, e.department_id)
      LEFT JOIN providers p ON p.id = t.provider_id
      WHERE (@includeRevoked = 1 OR t.revoked_at IS NULL)
        AND (@departmentId IS NULL OR d.id = @departmentId)
        AND (@employeeId IS NULL OR t.employee_id = @employeeId)
      ORDER BY (t.revoked_at IS NOT NULL), t.id DESC
    `);
    this.getStmt = db.prepare(`SELECT * FROM agent_tokens WHERE id = ?`);
    this.insertStmt = db.prepare(`
      INSERT INTO agent_tokens (token_sha256, token_prefix, label, principal_type, department_id,
        employee_id, provider_id, model, allowed_cidrs_json, expires_at, enabled, created_at)
      VALUES (@token_sha256, @token_prefix, @label, @principal_type, @department_id,
        @employee_id, @provider_id, @model, @allowed_cidrs_json, @expires_at, 1, @now)
    `);
    this.revokeStmt = db.prepare(
      `UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
    );
    this.touchStmt = db.prepare(`UPDATE agent_tokens SET last_used_at = ? WHERE id = ?`);
  }

  /** Всё, что нужно для снапшота реестра: действующие токены с включёнными владельцами. */
  listResolvable(): AgentTokenResolvableRow[] {
    return this.resolvableStmt.all() as AgentTokenResolvableRow[];
  }

  list(filter: AgentTokenFilter = {}): AgentTokenListRow[] {
    return this.listStmt.all({
      includeRevoked: filter.includeRevoked ? 1 : 0,
      departmentId: filter.departmentId ?? null,
      employeeId: filter.employeeId ?? null,
    }) as AgentTokenListRow[];
  }

  get(id: number): AgentTokenRow | null {
    return (this.getStmt.get(id) as AgentTokenRow | undefined) ?? null;
  }

  issue(input: AgentTokenInput, now: number): number {
    const r = withConflict('token hash collision', () => this.insertStmt.run({ ...input, now }));
    return Number(r.lastInsertRowid);
  }

  revoke(id: number, now: number): boolean {
    return this.revokeStmt.run(now, id).changes === 1;
  }

  update(id: number, patch: AgentTokenPatch): boolean {
    const u = buildUpdate('agent_tokens', 'id = @__id', PATCHABLE, patch);
    if (!u) return this.get(id) !== null;
    return this.db.prepare(u.sql).run({ ...u.params, __id: id }).changes === 1;
  }

  touchLastUsed(id: number, now: number): void {
    this.touchStmt.run(now, id);
  }
}

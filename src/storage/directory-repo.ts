import type Database from 'better-sqlite3';
import { buildUpdate } from './sql-util.js';
import { withConflict } from './errors.js';

export interface DepartmentRow {
  id: number;
  /** Неизменяемый после создания: попадает в client_id журнала (agent:dept:<slug>). */
  slug: string;
  name: string;
  max_concurrency: number | null;
  max_pending: number | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface DepartmentListRow extends DepartmentRow {
  employees_count: number;
  active_tokens: number;
}

export interface EmployeeRow {
  id: number;
  /** Неизменяемый после создания: попадает в client_id журнала (agent:emp:<login>). */
  login: string;
  display_name: string;
  email: string | null;
  department_id: number;
  max_concurrency: number | null;
  max_pending: number | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface EmployeeListRow extends EmployeeRow {
  department_slug: string;
  department_name: string;
  active_tokens: number;
}

export interface DepartmentInput {
  slug: string;
  name: string;
  max_concurrency: number | null;
  max_pending: number | null;
}
export type DepartmentPatch = Partial<Pick<DepartmentRow, 'name' | 'max_concurrency' | 'max_pending' | 'enabled'>>;

export interface EmployeeInput {
  login: string;
  display_name: string;
  email: string | null;
  department_id: number;
  max_concurrency: number | null;
  max_pending: number | null;
}
export type EmployeePatch = Partial<
  Pick<EmployeeRow, 'display_name' | 'email' | 'department_id' | 'max_concurrency' | 'max_pending' | 'enabled'>
>;

const DEPT_PATCHABLE = ['name', 'max_concurrency', 'max_pending', 'enabled'] as const;
const EMP_PATCHABLE = ['display_name', 'email', 'department_id', 'max_concurrency', 'max_pending', 'enabled'] as const;

export class DirectoryRepo {
  private readonly listDeptStmt;
  private readonly getDeptStmt;
  private readonly getDeptBySlugStmt;
  private readonly insertDeptStmt;
  private readonly listEmpStmt;
  private readonly getEmpStmt;
  private readonly getEmpByLoginStmt;
  private readonly insertEmpStmt;

  constructor(private readonly db: Database.Database) {
    this.listDeptStmt = db.prepare(`
      SELECT d.*,
        (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id) AS employees_count,
        (SELECT COUNT(*) FROM agent_tokens t
           WHERE t.department_id = d.id AND t.revoked_at IS NULL) AS active_tokens
      FROM departments d
      ORDER BY d.enabled DESC, d.name
    `);
    this.getDeptStmt = db.prepare(`SELECT * FROM departments WHERE id = ?`);
    this.getDeptBySlugStmt = db.prepare(`SELECT * FROM departments WHERE slug = ?`);
    this.insertDeptStmt = db.prepare(`
      INSERT INTO departments (slug, name, max_concurrency, max_pending, enabled, created_at, updated_at)
      VALUES (@slug, @name, @max_concurrency, @max_pending, 1, @now, @now)
    `);
    this.listEmpStmt = db.prepare(`
      SELECT e.*, d.slug AS department_slug, d.name AS department_name,
        (SELECT COUNT(*) FROM agent_tokens t
           WHERE t.employee_id = e.id AND t.revoked_at IS NULL) AS active_tokens
      FROM employees e
      JOIN departments d ON d.id = e.department_id
      WHERE (@departmentId IS NULL OR e.department_id = @departmentId)
      ORDER BY e.enabled DESC, e.display_name
    `);
    this.getEmpStmt = db.prepare(`SELECT * FROM employees WHERE id = ?`);
    this.getEmpByLoginStmt = db.prepare(`SELECT * FROM employees WHERE login = ?`);
    this.insertEmpStmt = db.prepare(`
      INSERT INTO employees (login, display_name, email, department_id, max_concurrency, max_pending,
                             enabled, created_at, updated_at)
      VALUES (@login, @display_name, @email, @department_id, @max_concurrency, @max_pending, 1, @now, @now)
    `);
  }

  listDepartments(): DepartmentListRow[] {
    return this.listDeptStmt.all() as DepartmentListRow[];
  }

  getDepartment(id: number): DepartmentRow | null {
    return (this.getDeptStmt.get(id) as DepartmentRow | undefined) ?? null;
  }

  getDepartmentBySlug(slug: string): DepartmentRow | null {
    return (this.getDeptBySlugStmt.get(slug) as DepartmentRow | undefined) ?? null;
  }

  createDepartment(input: DepartmentInput, now: number): number {
    const r = withConflict(`department "${input.slug}" already exists`, () =>
      this.insertDeptStmt.run({ ...input, now }),
    );
    return Number(r.lastInsertRowid);
  }

  updateDepartment(id: number, patch: DepartmentPatch, now: number): boolean {
    const u = buildUpdate('departments', 'id = @__id', DEPT_PATCHABLE, patch, { updated_at: now });
    if (!u) return this.getDepartment(id) !== null;
    return this.db.prepare(u.sql).run({ ...u.params, __id: id }).changes === 1;
  }

  listEmployees(filter: { departmentId?: number } = {}): EmployeeListRow[] {
    return this.listEmpStmt.all({ departmentId: filter.departmentId ?? null }) as EmployeeListRow[];
  }

  getEmployee(id: number): EmployeeRow | null {
    return (this.getEmpStmt.get(id) as EmployeeRow | undefined) ?? null;
  }

  getEmployeeByLogin(login: string): EmployeeRow | null {
    return (this.getEmpByLoginStmt.get(login) as EmployeeRow | undefined) ?? null;
  }

  createEmployee(input: EmployeeInput, now: number): number {
    const r = withConflict(`employee "${input.login}" already exists`, () =>
      this.insertEmpStmt.run({ ...input, now }),
    );
    return Number(r.lastInsertRowid);
  }

  updateEmployee(id: number, patch: EmployeePatch, now: number): boolean {
    const u = buildUpdate('employees', 'id = @__id', EMP_PATCHABLE, patch, { updated_at: now });
    if (!u) return this.getEmployee(id) !== null;
    return this.db.prepare(u.sql).run({ ...u.params, __id: id }).changes === 1;
  }
}

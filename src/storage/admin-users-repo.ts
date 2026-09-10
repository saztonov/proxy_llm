import type Database from 'better-sqlite3';
import { withConflict } from './errors.js';

export interface AdminUserRow {
  id: number;
  /** COLLATE NOCASE: логин регистронезависим. */
  login: string;
  password_hash: string;
  display_name: string;
  enabled: number;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

export type AdminUserPublic = Omit<AdminUserRow, 'password_hash'>;

export class AdminUsersRepo {
  private readonly countStmt;
  private readonly listStmt;
  private readonly getStmt;
  private readonly getByLoginStmt;
  private readonly insertStmt;
  private readonly setPasswordStmt;
  private readonly setEnabledStmt;
  private readonly touchLoginStmt;

  constructor(db: Database.Database) {
    this.countStmt = db.prepare(`SELECT COUNT(*) AS n FROM admin_users`);
    this.listStmt = db.prepare(`
      SELECT id, login, display_name, enabled, created_at, updated_at, last_login_at
      FROM admin_users ORDER BY login
    `);
    this.getStmt = db.prepare(`SELECT * FROM admin_users WHERE id = ?`);
    this.getByLoginStmt = db.prepare(`SELECT * FROM admin_users WHERE login = ?`);
    this.insertStmt = db.prepare(`
      INSERT INTO admin_users (login, password_hash, display_name, enabled, created_at, updated_at)
      VALUES (@login, @password_hash, @display_name, 1, @now, @now)
    `);
    this.setPasswordStmt = db.prepare(
      `UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?`,
    );
    this.setEnabledStmt = db.prepare(`UPDATE admin_users SET enabled = ?, updated_at = ? WHERE id = ?`);
    this.touchLoginStmt = db.prepare(`UPDATE admin_users SET last_login_at = ? WHERE id = ?`);
  }

  count(): number {
    return (this.countStmt.get() as { n: number }).n;
  }

  list(): AdminUserPublic[] {
    return this.listStmt.all() as AdminUserPublic[];
  }

  get(id: number): AdminUserRow | null {
    return (this.getStmt.get(id) as AdminUserRow | undefined) ?? null;
  }

  getByLogin(login: string): AdminUserRow | null {
    return (this.getByLoginStmt.get(login) as AdminUserRow | undefined) ?? null;
  }

  create(input: { login: string; password_hash: string; display_name: string }, now: number): number {
    const r = withConflict(`admin "${input.login}" already exists`, () =>
      this.insertStmt.run({ ...input, now }),
    );
    return Number(r.lastInsertRowid);
  }

  setPassword(id: number, passwordHash: string, now: number): boolean {
    return this.setPasswordStmt.run(passwordHash, now, id).changes === 1;
  }

  setEnabled(id: number, enabled: boolean, now: number): boolean {
    return this.setEnabledStmt.run(enabled ? 1 : 0, now, id).changes === 1;
  }

  touchLogin(id: number, now: number): void {
    this.touchLoginStmt.run(now, id);
  }
}

import type Database from 'better-sqlite3';

export interface AdminSessionRow {
  id: number;
  admin_id: number;
  token_sha256: string;
  family_id: string;
  created_at: number;
  expires_at: number;
  absolute_expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  revoke_reason: string | null;
  replaced_by_id: number | null;
  replaced_at: number | null;
  ip: string | null;
  user_agent: string | null;
}

export type AdminSessionInsert = Pick<
  AdminSessionRow,
  'admin_id' | 'token_sha256' | 'family_id' | 'created_at' | 'expires_at' | 'absolute_expires_at' | 'ip' | 'user_agent'
>;

export class AdminSessionsRepo {
  private readonly getByHashStmt;
  private readonly insertStmt;
  private readonly markReplacedStmt;
  private readonly revokeFamilyStmt;
  private readonly familiesOfAdminStmt;
  private readonly revokeAllStmt;
  private readonly activeStmt;
  private readonly purgeStmt;

  constructor(private readonly db: Database.Database) {
    this.getByHashStmt = db.prepare(`SELECT * FROM admin_sessions WHERE token_sha256 = ?`);
    this.insertStmt = db.prepare(`
      INSERT INTO admin_sessions (admin_id, token_sha256, family_id, created_at, expires_at,
                                  absolute_expires_at, last_used_at, ip, user_agent)
      VALUES (@admin_id, @token_sha256, @family_id, @created_at, @expires_at,
              @absolute_expires_at, @created_at, @ip, @user_agent)
    `);
    this.markReplacedStmt = db.prepare(
      `UPDATE admin_sessions SET replaced_by_id = ?, replaced_at = ?, last_used_at = ? WHERE id = ?`,
    );
    this.revokeFamilyStmt = db.prepare(`
      UPDATE admin_sessions SET revoked_at = ?, revoke_reason = ?
      WHERE family_id = ? AND revoked_at IS NULL
    `);
    this.familiesOfAdminStmt = db.prepare(
      `SELECT DISTINCT family_id FROM admin_sessions WHERE admin_id = ? AND revoked_at IS NULL`,
    );
    this.revokeAllStmt = db.prepare(`
      UPDATE admin_sessions SET revoked_at = ?, revoke_reason = ?
      WHERE admin_id = ? AND revoked_at IS NULL
    `);
    // «Голова» семейства: не отозвана, не заменена, в пределах абсолютного срока, админ включён.
    this.activeStmt = db.prepare(`
      SELECT 1 FROM admin_sessions s
      JOIN admin_users u ON u.id = s.admin_id
      WHERE s.family_id = ? AND s.admin_id = ? AND s.revoked_at IS NULL AND s.replaced_by_id IS NULL
        AND s.absolute_expires_at > ? AND u.enabled = 1
      LIMIT 1
    `);
    this.purgeStmt = db.prepare(`DELETE FROM admin_sessions WHERE absolute_expires_at < ?`);
  }

  /** BEGIN IMMEDIATE: ротация refresh не должна гоняться сама с собой. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  getByHash(sha256: string): AdminSessionRow | null {
    return (this.getByHashStmt.get(sha256) as AdminSessionRow | undefined) ?? null;
  }

  insert(row: AdminSessionInsert): number {
    return Number(this.insertStmt.run(row).lastInsertRowid);
  }

  markReplaced(id: number, newId: number, now: number): void {
    this.markReplacedStmt.run(newId, now, now, id);
  }

  revokeFamily(familyId: string, now: number, reason: string): number {
    return this.revokeFamilyStmt.run(now, reason, familyId).changes;
  }

  /** Отзывает все сессии админа; возвращает затронутые family_id. */
  revokeAllForAdmin(adminId: number, now: number, reason: string): string[] {
    const families = (this.familiesOfAdminStmt.all(adminId) as { family_id: string }[]).map(
      (r) => r.family_id,
    );
    this.revokeAllStmt.run(now, reason, adminId);
    return families;
  }

  /**
   * Проверка на каждом запросе с access-JWT: подпись доказывает лишь, что токен выдан нами, а не
   * что сессия ещё жива. Поэтому отзыв (logout, смена пароля, CLI) действует сразу и после рестарта.
   */
  isFamilyActive(familyId: string, adminId: number, now: number): boolean {
    return this.activeStmt.get(familyId, adminId, now) !== undefined;
  }

  purgeExpired(now: number): number {
    return this.purgeStmt.run(now).changes;
  }
}

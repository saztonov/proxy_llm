import type Database from 'better-sqlite3';

export interface AuditRow {
  id: number;
  ts: number;
  admin_id: number | null;
  admin_login: string | null;
  ip: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details_json: string | null;
}

export type AuditInsert = Omit<AuditRow, 'id'>;

export class AdminAuditRepo {
  private readonly insertStmt;
  private readonly listStmt;

  constructor(db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT INTO admin_audit_log (ts, admin_id, admin_login, ip, action, entity_type, entity_id, details_json)
      VALUES (@ts, @admin_id, @admin_login, @ip, @action, @entity_type, @entity_id, @details_json)
    `);
    this.listStmt = db.prepare(`
      SELECT * FROM admin_audit_log WHERE (@beforeId IS NULL OR id < @beforeId)
      ORDER BY id DESC LIMIT @limit
    `);
  }

  insert(row: AuditInsert): void {
    this.insertStmt.run(row);
  }

  listRecent(limit: number, beforeId: number | null = null): AuditRow[] {
    return this.listStmt.all({ limit, beforeId }) as AuditRow[];
  }
}

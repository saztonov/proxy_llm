import type Database from 'better-sqlite3';
import { withConflict } from './errors.js';

export interface SiteTokenRow {
  id: number;
  token_sha256: string;
  /** Отображаемое начало токена; NULL у импортированных из clients.json (показывается хэш). */
  token_prefix: string | null;
  label: string;
  client_id: string;
  created_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}

export interface SiteTokenInput {
  token_sha256: string;
  token_prefix: string | null;
  label: string;
  client_id: string;
}

export class SiteTokensRepo {
  private readonly listActiveStmt;
  private readonly listByClientStmt;
  private readonly getStmt;
  private readonly getByHashStmt;
  private readonly insertStmt;
  private readonly insertIgnoreStmt;
  private readonly revokeStmt;
  private readonly touchStmt;

  constructor(db: Database.Database) {
    this.listActiveStmt = db.prepare(`SELECT * FROM site_tokens WHERE revoked_at IS NULL ORDER BY id`);
    this.listByClientStmt = db.prepare(
      `SELECT * FROM site_tokens WHERE client_id = ? ORDER BY (revoked_at IS NOT NULL), id DESC`,
    );
    this.getStmt = db.prepare(`SELECT * FROM site_tokens WHERE id = ?`);
    this.getByHashStmt = db.prepare(`SELECT * FROM site_tokens WHERE token_sha256 = ?`);
    const ins = `INSERT INTO site_tokens (token_sha256, token_prefix, label, client_id, created_at)
                 VALUES (@token_sha256, @token_prefix, @label, @client_id, @created_at)`;
    this.insertStmt = db.prepare(ins);
    this.insertIgnoreStmt = db.prepare(`${ins} ON CONFLICT(token_sha256) DO NOTHING`);
    this.revokeStmt = db.prepare(
      `UPDATE site_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
    );
    this.touchStmt = db.prepare(`UPDATE site_tokens SET last_used_at = ? WHERE id = ?`);
  }

  listActive(): SiteTokenRow[] {
    return this.listActiveStmt.all() as SiteTokenRow[];
  }

  /** Все токены клиента, действующие первыми. */
  listByClient(clientId: string): SiteTokenRow[] {
    return this.listByClientStmt.all(clientId) as SiteTokenRow[];
  }

  get(id: number): SiteTokenRow | null {
    return (this.getStmt.get(id) as SiteTokenRow | undefined) ?? null;
  }

  getByHash(sha256: string): SiteTokenRow | null {
    return (this.getByHashStmt.get(sha256) as SiteTokenRow | undefined) ?? null;
  }

  issue(input: SiteTokenInput, now: number): number {
    const r = withConflict('token hash collision', () =>
      this.insertStmt.run({ ...input, created_at: now }),
    );
    return Number(r.lastInsertRowid);
  }

  /** Для bootstrap-импорта: известный хэш (в т.ч. отозванный) не трогает. true — вставлено. */
  insertIfAbsent(input: SiteTokenInput, now: number): boolean {
    return this.insertIgnoreStmt.run({ ...input, created_at: now }).changes === 1;
  }

  /** true — токен был действующим и теперь отозван. */
  revoke(id: number, now: number): boolean {
    return this.revokeStmt.run(now, id).changes === 1;
  }

  touchLastUsed(id: number, now: number): void {
    this.touchStmt.run(now, id);
  }
}

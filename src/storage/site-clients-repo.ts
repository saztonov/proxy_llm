import type Database from 'better-sqlite3';
import { buildUpdate } from './sql-util.js';
import { withConflict } from './errors.js';

/**
 * Клиент контура сайтов. Поля политики, равные NULL, наследуют env-дефолт — ровно как
 * отсутствующее поле в clients.json. `allowed_models_json = '[]'` — явный пин на defaultModel.
 */
export interface SiteClientRow {
  client_id: string;
  default_model: string | null;
  allowed_models_json: string | null;
  fallback_models_json: string | null;
  max_concurrency: number | null;
  max_pending: number | null;
  /** SecretBox.seal(ключ OpenRouter); NULL — общий OPENROUTER_API_KEY. */
  openrouter_api_key_enc: string | null;
  openrouter_api_key_fp: string | null;
  source: string | null;
  enabled: number;
  imported_from: string | null;
  created_at: number;
  updated_at: number;
}

export type SiteClientInput = Omit<SiteClientRow, 'created_at' | 'updated_at'>;
export type SiteClientPatch = Partial<
  Omit<SiteClientRow, 'client_id' | 'created_at' | 'updated_at' | 'imported_from'>
>;

const COLUMNS = [
  'client_id', 'default_model', 'allowed_models_json', 'fallback_models_json',
  'max_concurrency', 'max_pending', 'openrouter_api_key_enc', 'openrouter_api_key_fp',
  'source', 'enabled', 'imported_from', 'created_at', 'updated_at',
] as const;

const PATCHABLE = [
  'default_model', 'allowed_models_json', 'fallback_models_json', 'max_concurrency',
  'max_pending', 'openrouter_api_key_enc', 'openrouter_api_key_fp', 'source', 'enabled',
] as const;

export class SiteClientsRepo {
  private readonly listStmt;
  private readonly getStmt;
  private readonly insertStmt;
  private readonly insertIgnoreStmt;

  constructor(private readonly db: Database.Database) {
    const cols = COLUMNS.join(', ');
    const vals = COLUMNS.map((c) => `@${c}`).join(', ');
    this.listStmt = db.prepare(`SELECT * FROM site_clients ORDER BY client_id`);
    this.getStmt = db.prepare(`SELECT * FROM site_clients WHERE client_id = ?`);
    this.insertStmt = db.prepare(`INSERT INTO site_clients (${cols}) VALUES (${vals})`);
    this.insertIgnoreStmt = db.prepare(
      `INSERT INTO site_clients (${cols}) VALUES (${vals}) ON CONFLICT(client_id) DO NOTHING`,
    );
  }

  list(): SiteClientRow[] {
    return this.listStmt.all() as SiteClientRow[];
  }

  get(clientId: string): SiteClientRow | null {
    return (this.getStmt.get(clientId) as SiteClientRow | undefined) ?? null;
  }

  create(input: SiteClientInput, now: number): void {
    withConflict(`site client "${input.client_id}" already exists`, () =>
      this.insertStmt.run({ ...input, created_at: now, updated_at: now }),
    );
  }

  /** Для bootstrap-импорта: существующую запись не трогает. true — вставлено. */
  insertIfAbsent(input: SiteClientInput, now: number): boolean {
    return this.insertIgnoreStmt.run({ ...input, created_at: now, updated_at: now }).changes === 1;
  }

  /** undefined в patch — «не менять», null — сброс в NULL (наследовать env-дефолт). */
  update(clientId: string, patch: SiteClientPatch, now: number): boolean {
    const u = buildUpdate('site_clients', 'client_id = @__id', PATCHABLE, patch, { updated_at: now });
    if (!u) return this.get(clientId) !== null;
    return this.db.prepare(u.sql).run({ ...u.params, __id: clientId }).changes === 1;
  }
}

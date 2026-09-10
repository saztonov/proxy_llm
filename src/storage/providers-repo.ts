import type Database from 'better-sqlite3';
import { buildUpdate } from './sql-util.js';
import { withConflict } from './errors.js';

/**
 * Как просить у провайдера usage в стриме:
 *  auto           — по hostname (openrouter.ai → openrouter, иначе stream_options);
 *  openrouter     — `usage: {include: true}`;
 *  stream_options — `stream_options: {include_usage: true}` (OpenAI и совместимые);
 *  none           — ничего не добавлять (провайдер отвергает неизвестные поля).
 */
export type UsageMode = 'auto' | 'openrouter' | 'stream_options' | 'none';

export interface ProviderRow {
  id: number;
  name: string;
  kind: 'openai_compatible';
  base_url: string;
  api_key_enc: string | null;
  api_key_fp: string | null;
  extra_headers_enc: string | null;
  usage_mode: UsageMode;
  /** Потолок одновременных запросов к провайдеру; NULL — без лимита. */
  max_concurrency: number | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export type ProviderInput = Pick<
  ProviderRow,
  'name' | 'base_url' | 'api_key_enc' | 'api_key_fp' | 'extra_headers_enc' | 'usage_mode' | 'max_concurrency'
>;
export type ProviderPatch = Partial<Omit<ProviderRow, 'id' | 'kind' | 'created_at' | 'updated_at'>>;

const PATCHABLE = [
  'name', 'base_url', 'api_key_enc', 'api_key_fp', 'extra_headers_enc', 'usage_mode',
  'max_concurrency', 'enabled',
] as const;

export class ProvidersRepo {
  private readonly listStmt;
  private readonly getStmt;
  private readonly insertStmt;
  private readonly tokensStmt;

  constructor(private readonly db: Database.Database) {
    this.listStmt = db.prepare(`SELECT * FROM providers ORDER BY enabled DESC, name`);
    this.getStmt = db.prepare(`SELECT * FROM providers WHERE id = ?`);
    this.insertStmt = db.prepare(`
      INSERT INTO providers (name, kind, base_url, api_key_enc, api_key_fp, extra_headers_enc,
                             usage_mode, max_concurrency, enabled, created_at, updated_at)
      VALUES (@name, 'openai_compatible', @base_url, @api_key_enc, @api_key_fp, @extra_headers_enc,
              @usage_mode, @max_concurrency, 1, @now, @now)
    `);
    this.tokensStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM agent_tokens WHERE provider_id = ? AND revoked_at IS NULL`,
    );
  }

  list(): ProviderRow[] {
    return this.listStmt.all() as ProviderRow[];
  }

  get(id: number): ProviderRow | null {
    return (this.getStmt.get(id) as ProviderRow | undefined) ?? null;
  }

  create(input: ProviderInput, now: number): number {
    const r = withConflict(`provider "${input.name}" already exists`, () =>
      this.insertStmt.run({ ...input, now }),
    );
    return Number(r.lastInsertRowid);
  }

  update(id: number, patch: ProviderPatch, now: number): boolean {
    const u = buildUpdate('providers', 'id = @__id', PATCHABLE, patch, { updated_at: now });
    if (!u) return this.get(id) !== null;
    return withConflict(`provider "${String(patch.name)}" already exists`, () =>
      this.db.prepare(u.sql).run({ ...u.params, __id: id }).changes === 1,
    );
  }

  /** Сколько действующих агентских токенов закреплено за провайдером. */
  countActiveTokens(id: number): number {
    return (this.tokensStmt.get(id) as { n: number }).n;
  }
}

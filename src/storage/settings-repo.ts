import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';

export const SETTING = {
  agentDefaultProviderId: 'agent_default_provider_id',
  agentDefaultModel: 'agent_default_model',
  agentDefaultMaxConcurrency: 'agent_default_max_concurrency',
  agentDefaultMaxPending: 'agent_default_max_pending',
  /** JSON-маркер завершённого импорта clients.json — после него файл не читается. */
  siteBootstrap: 'site_bootstrap',
  /** Меняется CLI после правки реестров — сервис по нему перечитывает их (registry-watcher). */
  registryGeneration: 'registry_generation',
} as const;

export interface AgentDefaults {
  providerId: number | null;
  model: string | null;
  maxConcurrency: number | null;
  maxPending: number | null;
}

function intOrNull(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

export class SettingsRepo {
  private readonly getStmt;
  private readonly setStmt;
  private readonly delStmt;
  private readonly allStmt;

  constructor(db: Database.Database) {
    this.getStmt = db.prepare(`SELECT value FROM settings WHERE key = ?`);
    this.setStmt = db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    this.delStmt = db.prepare(`DELETE FROM settings WHERE key = ?`);
    this.allStmt = db.prepare(`SELECT key, value FROM settings ORDER BY key`);
  }

  get(key: string): string | null {
    return (this.getStmt.get(key) as { value: string } | undefined)?.value ?? null;
  }

  /** null — удалить ключ (вернуть к дефолту). */
  set(key: string, value: string | null, now: number): void {
    if (value === null) this.delStmt.run(key);
    else this.setStmt.run(key, value, now);
  }

  all(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.allStmt.all() as { key: string; value: string }[]) out[r.key] = r.value;
    return out;
  }

  agentDefaults(): AgentDefaults {
    return {
      providerId: intOrNull(this.get(SETTING.agentDefaultProviderId)),
      model: this.get(SETTING.agentDefaultModel),
      maxConcurrency: intOrNull(this.get(SETTING.agentDefaultMaxConcurrency)),
      maxPending: intOrNull(this.get(SETTING.agentDefaultMaxPending)),
    };
  }

  /** Отметка «реестры в БД изменены извне процесса» (CLI): новое случайное значение. */
  bumpRegistryGeneration(now: number): void {
    this.set(SETTING.registryGeneration, `${now}-${randomBytes(4).toString('hex')}`, now);
  }

  setAgentDefaults(d: AgentDefaults, now: number): void {
    const s = (v: number | string | null): string | null => (v === null ? null : String(v));
    this.set(SETTING.agentDefaultProviderId, s(d.providerId), now);
    this.set(SETTING.agentDefaultModel, s(d.model), now);
    this.set(SETTING.agentDefaultMaxConcurrency, s(d.maxConcurrency), now);
    this.set(SETTING.agentDefaultMaxPending, s(d.maxPending), now);
  }
}

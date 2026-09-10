import { z } from 'zod';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { resolveEntry, ClientRegistryError, type ClientConfig } from './registry.js';
import type { ClientEntry } from './registry-schema.js';
import { sha256Hex } from './tokens.js';
import type { SecretBox } from '../storage/secret-box.js';
import type { SiteClientRow, SiteClientsRepo } from '../storage/site-clients-repo.js';
import type { SiteTokensRepo } from '../storage/site-tokens-repo.js';
import { sanitizeErrorForLog } from '../utils/sanitize-error.js';

/** То, что нужно auth-хуку контура сайтов (реализуют SiteRegistry и файловый ClientRegistry). */
export interface TokenResolver {
  resolveToken(token: string): ClientConfig | null;
}

export interface SiteSnapshot {
  readonly byHash: ReadonlyMap<string, ClientConfig>;
  readonly clients: readonly ClientConfig[];
}

export interface ReloadDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface SiteRegistryDeps {
  config: Config;
  siteClients: SiteClientsRepo;
  siteTokens: SiteTokensRepo;
  secrets: SecretBox;
  logger: Logger;
  now?: () => number;
  /** Как часто обновлять last_used_at одного токена (по умолчанию 5 минут). */
  touchIntervalMs?: number;
}

const modelList = z.array(z.string().min(1));

function parseModels(json: string | null, field: string, clientId: string): string[] | undefined {
  if (json === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ClientRegistryError(`site_clients.${field} у ${clientId}: не JSON`);
  }
  const r = modelList.safeParse(parsed);
  if (!r.success) throw new ClientRegistryError(`site_clients.${field} у ${clientId}: ожидается массив строк`);
  return r.data;
}

/**
 * Строка БД → ClientEntry. NULL = поле отсутствует, ровно как в clients.json, поэтому дальше
 * работает тот же resolveEntry с теми же env-дефолтами — семантика `[]` против «не задано»
 * сохраняется без отдельного кода.
 */
export function rowToEntry(row: SiteClientRow, secrets: SecretBox): ClientEntry {
  const e: ClientEntry = { clientId: row.client_id };
  if (row.default_model !== null) e.defaultModel = row.default_model;
  const allowed = parseModels(row.allowed_models_json, 'allowed_models_json', row.client_id);
  if (allowed !== undefined) e.allowedModels = allowed;
  const fallback = parseModels(row.fallback_models_json, 'fallback_models_json', row.client_id);
  if (fallback !== undefined) e.fallbackModels = fallback;
  if (row.max_concurrency !== null) e.maxConcurrency = row.max_concurrency;
  if (row.max_pending !== null) e.maxPending = row.max_pending;
  if (row.openrouter_api_key_enc !== null) e.openrouterApiKey = secrets.open(row.openrouter_api_key_enc);
  if (row.source !== null) e.source = row.source;
  return e;
}

function policyKey(c: ClientConfig): string {
  return JSON.stringify([
    c.defaultModel, c.allowedModels, c.fallbackModels, c.maxConcurrency, c.maxPending,
    c.openrouterApiKey ?? null, c.source,
  ]);
}

export function diffClients(prev: readonly ClientConfig[], next: readonly ClientConfig[]): ReloadDiff {
  const before = new Map(prev.map((c) => [c.clientId, policyKey(c)]));
  const after = new Map(next.map((c) => [c.clientId, policyKey(c)]));
  const diff: ReloadDiff = { added: [], removed: [], changed: [] };
  for (const [id, key] of after) {
    const old = before.get(id);
    if (old === undefined) diff.added.push(id);
    else if (old !== key) diff.changed.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) diff.removed.push(id);
  return diff;
}

const DEFAULT_TOUCH_INTERVAL_MS = 5 * 60_000;

type ReloadListener = (clients: readonly ClientConfig[], diff: ReloadDiff) => void;

/**
 * Реестр контура сайтов поверх SQLite с горячей подменой.
 *
 * Снапшот неизменяем: запрос, уже получивший ClientConfig, дорабатывает со старой политикой,
 * новые запросы видят новую. Изменения применяются через prepare-then-publish: buildSnapshot()
 * вызывается внутри транзакции записи (видит её изменения и падает до commit, если данные не
 * собираются), publish() — после commit. Процесс один, поэтому pub/sub не нужен.
 */
export class SiteRegistry implements TokenResolver {
  private snap: SiteSnapshot;
  private readonly listeners: ReloadListener[] = [];
  private readonly lastTouch = new Map<number, number>();
  private readonly now: () => number;
  private readonly touchIntervalMs: number;

  constructor(private readonly deps: SiteRegistryDeps) {
    this.now = deps.now ?? Date.now;
    this.touchIntervalMs = deps.touchIntervalMs ?? DEFAULT_TOUCH_INTERVAL_MS;
    this.snap = this.buildSnapshot();
  }

  /** Бросает (битая политика, чужой ключ шифрования) — тогда прежний снапшот остаётся в силе. */
  buildSnapshot(): SiteSnapshot {
    const clients = new Map<string, ClientConfig>();
    for (const row of this.deps.siteClients.list()) {
      if (row.enabled !== 1) continue;
      clients.set(row.client_id, resolveEntry(rowToEntry(row, this.deps.secrets), this.deps.config));
    }
    const byHash = new Map<string, ClientConfig>();
    for (const t of this.deps.siteTokens.listActive()) {
      const cfg = clients.get(t.client_id);
      // Токены выключенного клиента не резолвятся, но и не отзываются: включили — работают.
      if (cfg) byHash.set(t.token_sha256, { ...cfg, tokenId: t.id });
    }
    return { byHash, clients: [...clients.values()] };
  }

  publish(next: SiteSnapshot): ReloadDiff {
    const diff = diffClients(this.snap.clients, next.clients);
    this.snap = next;
    for (const listener of this.listeners) {
      try {
        listener(next.clients, diff);
      } catch (err) {
        this.deps.logger.error({ err: sanitizeErrorForLog(err) }, 'site registry reload listener failed');
      }
    }
    if (diff.added.length + diff.removed.length + diff.changed.length > 0) {
      this.deps.logger.info({ ...diff }, 'site registry reloaded');
    }
    return diff;
  }

  reload(): ReloadDiff {
    return this.publish(this.buildSnapshot());
  }

  onReload(listener: ReloadListener): void {
    this.listeners.push(listener);
  }

  resolveToken(token: string): ClientConfig | null {
    const cfg = this.snap.byHash.get(sha256Hex(token)) ?? null;
    if (cfg?.tokenId !== undefined) this.touch(cfg.tokenId);
    return cfg;
  }

  /** Уникальные включённые клиенты (для слотов fairness). */
  clients(): readonly ClientConfig[] {
    return this.snap.clients;
  }

  /** last_used_at — не чаще раза в touchIntervalMs на токен, чтобы не писать в SQLite на каждый запрос. */
  private touch(id: number): void {
    const now = this.now();
    if (now - (this.lastTouch.get(id) ?? 0) < this.touchIntervalMs) return;
    this.lastTouch.set(id, now);
    try {
      this.deps.siteTokens.touchLastUsed(id, now);
    } catch (err) {
      this.deps.logger.warn({ err: sanitizeErrorForLog(err), tokenId: id }, 'failed to update last_used_at');
    }
  }
}

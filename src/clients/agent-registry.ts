import { BlockList } from 'node:net';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { sha256Hex } from './tokens.js';
import { ClientRegistryError } from './registry.js';
import type { SecretBox } from '../storage/secret-box.js';
import type { AgentTokensRepo, AgentTokenResolvableRow, PrincipalType } from '../storage/agent-tokens-repo.js';
import type { ProvidersRepo, ProviderRow } from '../storage/providers-repo.js';
import type { AgentDefaults, SettingsRepo } from '../storage/settings-repo.js';
import type { FairnessTenant, TenantSource } from '../concurrency/fairness.js';
import type { StreamUsageMode } from '../upstream/agent-payload.js';
import { sanitizeExtraHeaders } from '../upstream/provider-headers.js';
import { buildBlockList } from '../utils/cidr.js';
import { payerForProvider, type Payer } from '../billing/payer.js';
import { sanitizeErrorForLog } from '../utils/sanitize-error.js';

export type ProviderKind = 'openrouter' | 'generic';

/** Провайдер в рантайме: ключ и заголовки уже расшифрованы (только в памяти процесса). */
export interface AgentProvider {
  id: number;
  name: string;
  /** Без завершающего '/': клиент дописывает /chat/completions. */
  baseUrl: string;
  apiKey: string | null;
  extraHeaders: Readonly<Record<string, string>>;
  kind: ProviderKind;
  usageMode: StreamUsageMode;
  maxConcurrency: number | null;
  payer: Payer;
}

export interface AgentTarget {
  provider: AgentProvider;
  model: string;
  origin: 'token' | 'global_default';
}

export interface AgentPrincipal {
  tokenId: number;
  tokenLabel: string;
  tokenPrefix: string;
  principalType: PrincipalType;
  /** У токена сотрудника — отдел сотрудника (для отчётов по отделам). */
  departmentId: number;
  departmentSlug: string;
  employeeId: number | null;
  employeeLogin: string | null;
  /** client_id в журнале: agent:dept:<slug> | agent:emp:<login>. */
  clientIdForJournal: string;
  /**
   * Ключ слота fairness и rate-limit: emp:<id> | dept:<id>. Общий для всех токенов владельца —
   * выпуск второго токена не удваивает долю сотрудника в очереди.
   */
  slotKey: string;
  maxConcurrency: number;
  maxPending: number;
  /** null — без ограничения по IP. */
  allowedCidrs: BlockList | null;
  expiresAt: number | null;
  /** null — не настроены ни модель токена, ни глобальный дефолт (или провайдер выключен). */
  target: AgentTarget | null;
}

export interface AgentRegistryDeps {
  config: Config;
  agentTokens: AgentTokensRepo;
  providers: ProvidersRepo;
  settings: SettingsRepo;
  secrets: SecretBox;
  logger: Logger;
  now?: () => number;
  touchIntervalMs?: number;
}

export interface AgentSnapshot {
  readonly byHash: ReadonlyMap<string, AgentPrincipal>;
  readonly tenants: readonly FairnessTenant[];
  /** Id действующих токенов — чтобы оборвать запросы отозванных (см. app.ts). */
  readonly tokenIds: ReadonlySet<number>;
}

export function providerKind(baseUrl: string): ProviderKind {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai') ? 'openrouter' : 'generic';
  } catch {
    return 'generic';
  }
}

export function toAgentProvider(row: ProviderRow, secrets: SecretBox): AgentProvider {
  const kind = providerKind(row.base_url);
  const apiKey = row.api_key_enc ? secrets.open(row.api_key_enc) : null;
  let extraHeaders: Record<string, string> = {};
  if (row.extra_headers_enc) {
    const json = secrets.open(row.extra_headers_enc);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new ClientRegistryError(`providers.extra_headers у ${row.name}: не JSON`);
    }
    extraHeaders = sanitizeExtraHeaders(parsed);
  }
  const usageMode: StreamUsageMode =
    row.usage_mode === 'auto' ? (kind === 'openrouter' ? 'openrouter' : 'stream_options') : row.usage_mode;
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url.replace(/\/+$/, ''),
    apiKey,
    extraHeaders,
    kind,
    usageMode,
    maxConcurrency: row.max_concurrency,
    payer: payerForProvider(row.name, apiKey),
  };
}

const DEFAULT_TOUCH_INTERVAL_MS = 5 * 60_000;
type ReloadListener = (tenants: readonly FairnessTenant[]) => void;

/**
 * Реестр агентских токенов: снапшот в памяти, горячая подмена (как SiteRegistry).
 * Резолв — sha256 токена → принципал с уже расшифрованной целевой моделью и провайдером.
 */
export class AgentRegistry implements TenantSource {
  private snap: AgentSnapshot;
  private readonly listeners: ReloadListener[] = [];
  private readonly lastTouch = new Map<number, number>();
  private readonly now: () => number;
  private readonly touchIntervalMs: number;

  constructor(private readonly deps: AgentRegistryDeps) {
    this.now = deps.now ?? Date.now;
    this.touchIntervalMs = deps.touchIntervalMs ?? DEFAULT_TOUCH_INTERVAL_MS;
    this.snap = this.buildSnapshot();
  }

  buildSnapshot(): AgentSnapshot {
    const providers = new Map<number, AgentProvider>();
    for (const row of this.deps.providers.list()) {
      if (row.enabled === 1) providers.set(row.id, toAgentProvider(row, this.deps.secrets));
    }
    const defaults = this.deps.settings.agentDefaults();
    const defaultProvider = defaults.providerId !== null ? providers.get(defaults.providerId) : undefined;
    const globalTarget: AgentTarget | null =
      defaultProvider && defaults.model
        ? { provider: defaultProvider, model: defaults.model, origin: 'global_default' }
        : null;

    const byHash = new Map<string, AgentPrincipal>();
    const tenants = new Map<string, FairnessTenant>();
    const tokenIds = new Set<number>();
    for (const row of this.deps.agentTokens.listResolvable()) {
      const p = this.principalOf(row, providers, globalTarget, defaults);
      byHash.set(row.token_sha256, p);
      tokenIds.add(row.id);
      tenants.set(p.slotKey, { clientId: p.slotKey, maxConcurrency: p.maxConcurrency, maxPending: p.maxPending });
    }
    return { byHash, tenants: [...tenants.values()], tokenIds };
  }

  private principalOf(
    row: AgentTokenResolvableRow,
    providers: ReadonlyMap<number, AgentProvider>,
    globalTarget: AgentTarget | null,
    defaults: AgentDefaults,
  ): AgentPrincipal {
    const isEmployee = row.principal_type === 'employee';
    const ownConcurrency = isEmployee ? row.employee_max_concurrency : row.department_max_concurrency;
    const ownPending = isEmployee ? row.employee_max_pending : row.department_max_pending;

    // Провайдер токена выключен — модель токена недоступна. Молча уводить на глобальный
    // дефолт нельзя: это сменило бы и модель, и плательщика без ведома админа.
    let target: AgentTarget | null = globalTarget;
    if (row.provider_id !== null && row.model !== null) {
      const provider = providers.get(row.provider_id);
      target = provider ? { provider, model: row.model, origin: 'token' } : null;
    }

    let allowedCidrs: BlockList | null = null;
    if (row.allowed_cidrs_json) {
      try {
        const list: unknown = JSON.parse(row.allowed_cidrs_json);
        if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) throw new Error('not a string array');
        allowedCidrs = buildBlockList(list as string[]);
      } catch (err) {
        // Fail closed: битый список сетей не должен превращаться в «без ограничений».
        this.deps.logger.warn({ tokenId: row.id, err: sanitizeErrorForLog(err) }, 'agent token has invalid allowed_cidrs; token blocked');
        allowedCidrs = new BlockList();
      }
    }

    return {
      tokenId: row.id,
      tokenLabel: row.label,
      tokenPrefix: row.token_prefix,
      principalType: row.principal_type,
      departmentId: row.eff_department_id,
      departmentSlug: row.department_slug,
      employeeId: row.employee_id,
      employeeLogin: row.employee_login,
      clientIdForJournal: isEmployee ? `agent:emp:${row.employee_login}` : `agent:dept:${row.department_slug}`,
      slotKey: isEmployee ? `emp:${row.employee_id}` : `dept:${row.eff_department_id}`,
      maxConcurrency: ownConcurrency ?? defaults.maxConcurrency ?? this.deps.config.AGENT_PRINCIPAL_MAX_CONCURRENCY,
      maxPending: ownPending ?? defaults.maxPending ?? this.deps.config.AGENT_PRINCIPAL_MAX_PENDING,
      allowedCidrs,
      expiresAt: row.expires_at,
      target,
    };
  }

  publish(next: AgentSnapshot): void {
    this.snap = next;
    for (const listener of this.listeners) {
      try {
        listener(next.tenants);
      } catch (err) {
        this.deps.logger.error({ err: sanitizeErrorForLog(err) }, 'agent registry reload listener failed');
      }
    }
  }

  reload(): void {
    this.publish(this.buildSnapshot());
  }

  onReload(listener: ReloadListener): void {
    this.listeners.push(listener);
  }

  /** null — неизвестный, отозванный, выключенный или истёкший токен (снаружи — один и тот же 401). */
  resolveToken(token: string): AgentPrincipal | null {
    const p = this.snap.byHash.get(sha256Hex(token)) ?? null;
    if (!p) return null;
    const now = this.now();
    if (p.expiresAt !== null && p.expiresAt <= now) return null;
    this.touch(p.tokenId, now);
    return p;
  }

  clients(): readonly FairnessTenant[] {
    return this.snap.tenants;
  }

  /** Токен действует: не отозван, владелец не выключен (срок здесь не проверяется). */
  hasToken(tokenId: number): boolean {
    return this.snap.tokenIds.has(tokenId);
  }

  private touch(id: number, now: number): void {
    if (now - (this.lastTouch.get(id) ?? 0) < this.touchIntervalMs) return;
    this.lastTouch.set(id, now);
    try {
      this.deps.agentTokens.touchLastUsed(id, now);
    } catch (err) {
      this.deps.logger.warn({ err: sanitizeErrorForLog(err), tokenId: id }, 'failed to update last_used_at');
    }
  }
}

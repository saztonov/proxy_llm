import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { clientsFileSchema, type ClientEntry } from './registry-schema.js';

export const DEFAULT_CLIENTS_PATH = '/etc/proxy_llm/clients.json';

/** Резолвнутая рантайм-конфигурация клиента (все дефолты подставлены). */
export interface ClientConfig {
  clientId: string;
  /** Модель по умолчанию, если клиент не прислал `model` (или его allowlist пуст). */
  defaultModel: string;
  /** Пустой массив = клиент НЕ может выбирать модель (форс defaultModel), legacy-поведение. */
  allowedModels: string[];
  fallbackModels: string[];
  maxConcurrency: number;
  maxPending: number;
  /** Опциональный per-tenant ключ OpenRouter (биллинговая изоляция); иначе глобальный. */
  openrouterApiKey?: string;
  /** Тег `source` для журнала (по умолчанию = clientId). */
  source: string;
}

export class ClientRegistryError extends Error {
  override readonly name = 'ClientRegistryError';
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Реестр клиентов: резолвит предъявленный Bearer-токен в ClientConfig за O(1) по sha256-хэшу.
 *
 * Хэш вместо timingSafeEqual против N токенов: побайтовое сравнение по списку — это O(N)-скан,
 * который своим временем выдаёт, какой токен совпал; хэш даёт фиксированные 64 hex + Map-lookup
 * (атакующему пришлось бы брутфорсить прообраз SHA-256).
 */
export class ClientRegistry {
  private readonly byHash: Map<string, ClientConfig>;
  private readonly unique: ClientConfig[];

  constructor(byHash: Map<string, ClientConfig>, unique: ClientConfig[]) {
    this.byHash = byHash;
    this.unique = unique;
  }

  resolveToken(token: string): ClientConfig | null {
    return this.byHash.get(sha256Hex(token)) ?? null;
  }

  /** Уникальные клиенты (для предсоздания пер-клиентских очередей). */
  clients(): ClientConfig[] {
    return this.unique;
  }
}

function resolveEntry(entry: ClientEntry, config: Config): ClientConfig {
  return {
    clientId: entry.clientId,
    defaultModel: entry.defaultModel ?? config.OPENROUTER_MODEL,
    allowedModels: entry.allowedModels ?? config.CLIENT_DEFAULT_ALLOWED_MODELS,
    fallbackModels: entry.fallbackModels ?? config.OPENROUTER_FALLBACK_MODELS,
    maxConcurrency: entry.maxConcurrency ?? config.CLIENT_DEFAULT_MAX_CONCURRENCY,
    maxPending: entry.maxPending ?? config.CLIENT_DEFAULT_MAX_PENDING,
    ...(entry.openrouterApiKey ? { openrouterApiKey: entry.openrouterApiKey } : {}),
    source: entry.source ?? entry.clientId,
  };
}

/** Хэши всех токенов клиента (открытые → sha256, плюс уже готовые sha256). */
function entryHashes(entry: ClientEntry): string[] {
  const fromPlain = (entry.tokens ?? []).map(sha256Hex);
  const fromHashes = (entry.tokenSha256 ?? []).map((h) => h.toLowerCase());
  return [...fromPlain, ...fromHashes];
}

/** Legacy single-tenant клиент из env (обратная совместимость: токен всегда резолвится). */
function legacyClient(config: Config): ClientConfig {
  return {
    clientId: 'passdesk',
    defaultModel: config.OPENROUTER_MODEL,
    allowedModels: [], // форс дефолт-модели — ровно как сегодня
    fallbackModels: config.OPENROUTER_FALLBACK_MODELS,
    maxConcurrency: config.CLIENT_DEFAULT_MAX_CONCURRENCY,
    maxPending: config.CLIENT_DEFAULT_MAX_PENDING,
    source: 'passdesk',
  };
}

/**
 * Загружает реестр.
 * - Путь НЕ задан (env отсутствует) и дефолтного файла нет → только legacy-клиент.
 * - Путь задан ЯВНО, но файла нет → fail-fast (сломанный/отсутствующий явный конфиг опасен).
 * - Файл присутствует, но битый JSON / не проходит zod / дубли → fail-fast.
 * - PROXY_INBOUND_TOKEN всегда резолвится (добавляется как legacy, если его хэша ещё нет).
 */
export function loadClientRegistry(config: Config): ClientRegistry {
  const explicit = config.CLIENTS_CONFIG_PATH !== undefined;
  const path = config.CLIENTS_CONFIG_PATH ?? DEFAULT_CLIENTS_PATH;

  let raw: string | null = null;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      if (explicit) {
        throw new ClientRegistryError(`CLIENTS_CONFIG_PATH задан (${path}), но файл не найден`);
      }
      raw = null; // дефолтный путь без файла → legacy-only
    } else {
      throw new ClientRegistryError(`не удалось прочитать ${path}: ${(err as Error).message}`);
    }
  }

  const byHash = new Map<string, ClientConfig>();
  const unique: ClientConfig[] = [];
  const seenClientIds = new Set<string>();

  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ClientRegistryError(`невалидный JSON в ${path}: ${(err as Error).message}`);
    }
    const result = clientsFileSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new ClientRegistryError(`невалидный ${path}: ${issues}`);
    }

    for (const entry of result.data.clients) {
      if (seenClientIds.has(entry.clientId)) {
        throw new ClientRegistryError(`дублирующийся clientId: ${entry.clientId}`);
      }
      seenClientIds.add(entry.clientId);

      const cfg = resolveEntry(entry, config);
      unique.push(cfg);
      for (const h of entryHashes(entry)) {
        if (byHash.has(h)) {
          throw new ClientRegistryError(`дублирующийся токен (hash) у clientId=${entry.clientId}`);
        }
        byHash.set(h, cfg);
      }
    }
  }

  // Гарантия совместимости: legacy-токен всегда резолвится (если ещё не занят файлом).
  const legacyHash = sha256Hex(config.PROXY_INBOUND_TOKEN);
  if (!byHash.has(legacyHash)) {
    const legacy = legacyClient(config);
    // Не пересоздаём клиента 'passdesk', если он уже описан в файле — просто вешаем на него токен.
    const existing = unique.find((c) => c.clientId === legacy.clientId);
    const cfg = existing ?? legacy;
    if (!existing) unique.push(cfg);
    byHash.set(legacyHash, cfg);
  }

  return new ClientRegistry(byHash, unique);
}

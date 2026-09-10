import { readFileSync } from 'node:fs';
import type { Config } from '../config.js';
import { clientsFileSchema, type ClientEntry } from './registry-schema.js';
import { sha256Hex } from './tokens.js';

export const DEFAULT_CLIENTS_PATH = '/etc/proxy_llm/clients.json';

/** Резолвнутая рантайм-конфигурация клиента (все дефолты подставлены). */
export interface ClientConfig {
  clientId: string;
  /** Модель по умолчанию: клиент не прислал `model`, прислал заглушку или его allowlist пуст. */
  defaultModel: string;
  /**
   * Белый список моделей: пустой = клиент НЕ выбирает модель (форс defaultModel, legacy);
   * `['*']` = любая модель OpenRouter; иначе — только перечисленные.
   */
  allowedModels: string[];
  fallbackModels: string[];
  maxConcurrency: number;
  maxPending: number;
  /** Опциональный per-tenant ключ OpenRouter (биллинговая изоляция); иначе глобальный. */
  openrouterApiKey?: string;
  /** Тег `source` для журнала (по умолчанию = clientId). */
  source: string;
  /** site_tokens.id токена, которым аутентифицирован запрос (SiteRegistry). */
  tokenId?: number;
}

export class ClientRegistryError extends Error {
  override readonly name = 'ClientRegistryError';
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

export function resolveEntry(entry: ClientEntry, config: Config): ClientConfig {
  return {
    clientId: entry.clientId,
    defaultModel: entry.defaultModel ?? config.OPENROUTER_MODEL,
    // `[] ?? x` даёт `[]` — пустой массив не nullish. Т.е. явный "allowedModels": [] в файле
    // перебивает глобальный CLIENT_DEFAULT_ALLOWED_MODELS и форсит дефолт-модель. Это
    // единственный рычаг оператора удержать недоработанного клиента на старом поведении,
    // когда выбор модели включён глобально.
    allowedModels: entry.allowedModels ?? config.CLIENT_DEFAULT_ALLOWED_MODELS,
    fallbackModels: entry.fallbackModels ?? config.OPENROUTER_FALLBACK_MODELS,
    maxConcurrency: entry.maxConcurrency ?? config.CLIENT_DEFAULT_MAX_CONCURRENCY,
    maxPending: entry.maxPending ?? config.CLIENT_DEFAULT_MAX_PENDING,
    ...(entry.openrouterApiKey ? { openrouterApiKey: entry.openrouterApiKey } : {}),
    source: entry.source ?? entry.clientId,
  };
}

/** Хэши всех токенов клиента (открытые → sha256, плюс уже готовые sha256). */
export function entryHashes(entry: ClientEntry): string[] {
  const fromPlain = (entry.tokens ?? []).map(sha256Hex);
  const fromHashes = (entry.tokenSha256 ?? []).map((h) => h.toLowerCase());
  return [...fromPlain, ...fromHashes];
}

/** Legacy single-tenant клиент из env (обратная совместимость: токен всегда резолвится). */
export function legacyClient(config: Config): ClientConfig {
  return {
    clientId: 'passdesk',
    defaultModel: config.OPENROUTER_MODEL,
    // Тот же дефолт, что и у клиентов из файла: иначе passdesk вёл бы себя по-разному в
    // зависимости от того, описан он в clients.json или нет.
    allowedModels: config.CLIENT_DEFAULT_ALLOWED_MODELS,
    fallbackModels: config.OPENROUTER_FALLBACK_MODELS,
    maxConcurrency: config.CLIENT_DEFAULT_MAX_CONCURRENCY,
    maxPending: config.CLIENT_DEFAULT_MAX_PENDING,
    source: 'passdesk',
  };
}

export interface ClientsFileContent {
  path: string;
  entries: ClientEntry[];
}

/**
 * Читает и валидирует clients.json.
 * - Путь НЕ задан (env отсутствует) и дефолтного файла нет → null.
 * - Путь задан ЯВНО, но файла нет → fail-fast (сломанный/отсутствующий явный конфиг опасен).
 * - Файл есть, но битый JSON / не проходит zod / дубли clientId или токенов → fail-fast.
 */
export function readClientsFile(config: Config): ClientsFileContent | null {
  const explicit = config.CLIENTS_CONFIG_PATH !== undefined;
  const path = config.CLIENTS_CONFIG_PATH ?? DEFAULT_CLIENTS_PATH;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      if (explicit) {
        throw new ClientRegistryError(`CLIENTS_CONFIG_PATH задан (${path}), но файл не найден`);
      }
      return null;
    }
    throw new ClientRegistryError(`не удалось прочитать ${path}: ${(err as Error).message}`);
  }

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

  const seenClientIds = new Set<string>();
  const seenHashes = new Set<string>();
  for (const entry of result.data.clients) {
    if (seenClientIds.has(entry.clientId)) {
      throw new ClientRegistryError(`дублирующийся clientId: ${entry.clientId}`);
    }
    seenClientIds.add(entry.clientId);
    for (const h of entryHashes(entry)) {
      if (seenHashes.has(h)) {
        throw new ClientRegistryError(`дублирующийся токен (hash) у clientId=${entry.clientId}`);
      }
      seenHashes.add(h);
    }
  }
  return { path, entries: result.data.clients };
}

/**
 * Файловый реестр (без БД). В рантайме сервиса больше не используется — там SiteRegistry поверх
 * SQLite, куда clients.json импортируется один раз (site-bootstrap.ts). Остаётся как валидатор
 * файла и эталон семантики: SiteRegistry обязан резолвить токены ровно так же.
 * PROXY_INBOUND_TOKEN резолвится всегда (добавляется как legacy, если его хэша ещё нет).
 */
export function loadClientRegistry(config: Config): ClientRegistry {
  const file = readClientsFile(config);
  const byHash = new Map<string, ClientConfig>();
  const unique: ClientConfig[] = [];

  for (const entry of file?.entries ?? []) {
    const cfg = resolveEntry(entry, config);
    unique.push(cfg);
    for (const h of entryHashes(entry)) byHash.set(h, cfg);
  }

  // Гарантия совместимости: legacy-токен всегда резолвится (если ещё не занят файлом).
  const legacyHash = config.PROXY_INBOUND_TOKEN ? sha256Hex(config.PROXY_INBOUND_TOKEN) : null;
  if (legacyHash !== null && !byHash.has(legacyHash)) {
    const legacy = legacyClient(config);
    // Не пересоздаём клиента 'passdesk', если он уже описан в файле — просто вешаем на него токен.
    const existing = unique.find((c) => c.clientId === legacy.clientId);
    const cfg = existing ?? legacy;
    if (!existing) unique.push(cfg);
    byHash.set(legacyHash, cfg);
  }

  return new ClientRegistry(byHash, unique);
}

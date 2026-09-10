import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { readClientsFile, entryHashes } from './registry.js';
import type { ClientEntry } from './registry-schema.js';
import { sha256Hex } from './tokens.js';
import { SecretBox } from '../storage/secret-box.js';
import type { SiteClientsRepo, SiteClientInput } from '../storage/site-clients-repo.js';
import type { SiteTokensRepo } from '../storage/site-tokens-repo.js';
import { SETTING, type SettingsRepo } from '../storage/settings-repo.js';

/** Клиент, к которому исторически привязан PROXY_INBOUND_TOKEN (registry.ts, legacyClient). */
export const LEGACY_CLIENT_ID = 'passdesk';

export interface ImportCounts {
  clientsInserted: number;
  clientsSkipped: number;
  tokensInserted: number;
  tokensSkipped: number;
}

export interface BootstrapResult extends ImportCounts {
  status: 'imported' | 'already_done';
  path: string | null;
  legacyTokenImported: boolean;
}

export interface SiteImportDeps {
  siteClients: SiteClientsRepo;
  siteTokens: SiteTokensRepo;
  secrets: SecretBox;
}

export interface BootstrapDeps extends SiteImportDeps {
  db: Database.Database;
  config: Config;
  settings: SettingsRepo;
  logger: Logger;
  now?: () => number;
}

const ZERO: ImportCounts = { clientsInserted: 0, clientsSkipped: 0, tokensInserted: 0, tokensSkipped: 0 };

/** Пустая политика: все поля NULL = наследовать env-дефолты, как запись без полей в clients.json. */
function inheritAll(clientId: string, importedFrom: string | null): SiteClientInput {
  return {
    client_id: clientId, default_model: null, allowed_models_json: null, fallback_models_json: null,
    max_concurrency: null, max_pending: null, openrouter_api_key_enc: null, openrouter_api_key_fp: null,
    source: null, enabled: 1, imported_from: importedFrom,
  };
}

/**
 * Идемпотентный импорт записей clients.json. Существующих клиентов и известные хэши (в том
 * числе отозванные) не трогает: отозванный в админке токен повторный импорт не воскресит.
 * Поля переносятся как есть: отсутствующее → NULL, явный `"allowedModels": []` → '[]'.
 */
export function importClientEntries(
  deps: SiteImportDeps,
  entries: readonly ClientEntry[],
  importedFrom: string | null,
  now: number,
): ImportCounts {
  const counts = { ...ZERO };
  for (const e of entries) {
    const key = e.openrouterApiKey;
    const inserted = deps.siteClients.insertIfAbsent({
      ...inheritAll(e.clientId, importedFrom),
      default_model: e.defaultModel ?? null,
      allowed_models_json: e.allowedModels !== undefined ? JSON.stringify(e.allowedModels) : null,
      fallback_models_json: e.fallbackModels !== undefined ? JSON.stringify(e.fallbackModels) : null,
      max_concurrency: e.maxConcurrency ?? null,
      max_pending: e.maxPending ?? null,
      openrouter_api_key_enc: key ? deps.secrets.seal(key) : null,
      openrouter_api_key_fp: key ? SecretBox.fingerprint(key) : null,
      source: e.source ?? null,
    }, now);
    if (inserted) counts.clientsInserted += 1;
    else counts.clientsSkipped += 1;

    // Открытые токены из файла в БД не попадают — только хэш; префикс неизвестен и не нужен.
    entryHashes(e).forEach((hash, i) => {
      const ok = deps.siteTokens.insertIfAbsent(
        { token_sha256: hash, token_prefix: null, label: `clients.json #${i + 1}`, client_id: e.clientId },
        now,
      );
      if (ok) counts.tokensInserted += 1;
      else counts.tokensSkipped += 1;
    });
  }
  return counts;
}

/**
 * Одноразовый перенос реестра сайтов из clients.json и PROXY_INBOUND_TOKEN в БД.
 *
 * После успешного импорта в settings пишется маркер, и файл больше не читается: источник
 * правды — БД (админка, CLI). Иначе порча старого файла однажды остановила бы сервис, а
 * удалённые в админке записи возвращались бы из файла. Повторный импорт — только явно:
 * `npm run admin -- import-clients --file <path>`.
 *
 * До маркера семантика прежняя: явный путь без файла или битый файл — сервис не стартует,
 * и в БД ничего не пишется (файл читается до транзакции).
 */
export function bootstrapSiteRegistry(deps: BootstrapDeps): BootstrapResult {
  const now = (deps.now ?? Date.now)();

  if (deps.settings.get(SETTING.siteBootstrap) !== null) {
    if (deps.config.CLIENTS_CONFIG_PATH !== undefined) {
      deps.logger.warn(
        { path: deps.config.CLIENTS_CONFIG_PATH },
        'CLIENTS_CONFIG_PATH is ignored: the site registry lives in the DB since the first import ' +
          '(npm run admin -- import-clients to import again)',
      );
    }
    warnIfLegacyTokenInactive(deps);
    return { status: 'already_done', path: null, legacyTokenImported: false, ...ZERO };
  }

  const file = readClientsFile(deps.config);
  const path = file?.path ?? null;
  const result = deps.db.transaction((): BootstrapResult => {
    const counts = importClientEntries(deps, file?.entries ?? [], path, now);
    const legacyTokenImported = importLegacyToken(deps, now);
    deps.settings.set(
      SETTING.siteBootstrap,
      JSON.stringify({ at: now, path, ...counts, legacyTokenImported }),
      now,
    );
    return { status: 'imported', path, legacyTokenImported, ...counts };
  })();

  deps.logger.info({ ...result }, 'site registry imported into DB');
  return result;
}

/**
 * PROXY_INBOUND_TOKEN становится обычным токеном клиента passdesk: его можно отозвать или
 * отключить вместе с клиентом, и overlay в обход БД больше не нужен. Если хэш уже заявлен
 * файлом — токен остаётся у того клиента, как и раньше в registry.ts.
 */
function importLegacyToken(deps: BootstrapDeps, now: number): boolean {
  const token = deps.config.PROXY_INBOUND_TOKEN;
  if (!token) return false;
  const hash = sha256Hex(token);
  if (deps.siteTokens.getByHash(hash) !== null) return false;
  deps.siteClients.insertIfAbsent(inheritAll(LEGACY_CLIENT_ID, 'env:PROXY_INBOUND_TOKEN'), now);
  return deps.siteTokens.insertIfAbsent(
    { token_sha256: hash, token_prefix: null, label: 'legacy env PROXY_INBOUND_TOKEN', client_id: LEGACY_CLIENT_ID },
    now,
  );
}

/** После импорта env-токен сам по себе ничего не значит — предупреждаем, если он «висит». */
function warnIfLegacyTokenInactive(deps: BootstrapDeps): void {
  const token = deps.config.PROXY_INBOUND_TOKEN;
  if (!token) return;
  const row = deps.siteTokens.getByHash(sha256Hex(token));
  if (row === null || row.revoked_at !== null) {
    deps.logger.warn(
      'PROXY_INBOUND_TOKEN is set but is not an active token in the DB, so it is ignored; manage site tokens in /admin',
    );
  }
}

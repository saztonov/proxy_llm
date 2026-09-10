import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/storage/db.js';
import { createRepos, type Repos } from '../src/storage/repos.js';
import { SecretBox } from '../src/storage/secret-box.js';
import { bootstrapSiteRegistry } from '../src/clients/site-bootstrap.js';
import { SiteRegistry } from '../src/clients/site-registry.js';
import { ClientRegistryError } from '../src/clients/registry.js';
import { sha256Hex } from '../src/clients/tokens.js';
import type { Config } from '../src/config.js';
import { makeTestConfig } from './helpers/test-config.js';
import { capturingLogger } from './helpers/silent-logger.js';

const A = 'alpha-token-1234567890';
const B = 'beta-token-1234567890';
const LEGACY = 'legacy-token-1234567890';

describe('site registry in the DB', () => {
  let dir: string;
  let handle: DbHandle;
  let repos: Repos;
  let config: Config;
  const secrets = new SecretBox('s'.repeat(32));
  const cap = capturingLogger();

  const writeClients = (clients: unknown[]): string => {
    const p = join(dir, 'clients.json');
    writeFileSync(p, JSON.stringify({ clients }), 'utf8');
    return p;
  };
  const boot = (cfg: Config) =>
    bootstrapSiteRegistry({ db: handle.db, config: cfg, ...repos, secrets, logger: cap.logger });
  const registry = (cfg: Config, now?: () => number) =>
    new SiteRegistry({ config: cfg, ...repos, secrets, logger: cap.logger, ...(now ? { now } : {}) });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proxy_llm-sr-'));
    handle = openDb(join(dir, 't.db'));
    repos = createRepos(handle.db);
    config = makeTestConfig({
      PROXY_INBOUND_TOKEN: LEGACY,
      CLIENT_DEFAULT_ALLOWED_MODELS: ['*'],
      CLIENTS_CONFIG_PATH: writeClients([
        { clientId: 'alpha', tokens: [A], allowedModels: [], openrouterApiKey: 'sk-or-alpha', maxConcurrency: 2 },
        { clientId: 'beta', tokenSha256: [sha256Hex(B)] },
      ]),
    });
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('imports once, then never reads the file again', () => {
    const first = boot(config);
    // passdesk создаётся переносом legacy-токена и в счётчики файла не входит.
    expect(first).toMatchObject({ status: 'imported', clientsInserted: 2, tokensInserted: 2, legacyTokenImported: true });
    rmSync(config.CLIENTS_CONFIG_PATH!);
    expect(boot(config).status).toBe('already_done');
    writeFileSync(join(dir, 'clients.json'), '{broken', 'utf8');
    expect(() => boot(config)).not.toThrow();
    expect(repos.siteClients.list().map((c) => c.client_id)).toEqual(['alpha', 'beta', 'passdesk']);
  });

  it('before the first import a missing explicit file still fails fast and writes nothing', () => {
    const bad = { ...config, CLIENTS_CONFIG_PATH: join(dir, 'nope.json') };
    expect(() => boot(bad)).toThrow(ClientRegistryError);
    expect(repos.settings.get('site_bootstrap')).toBeNull();
    expect(repos.siteClients.list()).toHaveLength(0);
  });

  it('keeps [] vs absent semantics and encrypts the per-client key at rest', () => {
    boot(config);
    const reg = registry(config);
    expect(reg.resolveToken(A)!.allowedModels).toEqual([]);
    expect(reg.resolveToken(B)!.allowedModels).toEqual(['*']);
    expect(reg.resolveToken(A)!.openrouterApiKey).toBe('sk-or-alpha');
    expect(reg.resolveToken(A)!.maxConcurrency).toBe(2);
    const raw = JSON.stringify(handle.db.prepare('SELECT * FROM site_clients').all());
    expect(raw).not.toContain('sk-or-alpha');
    expect(JSON.stringify(handle.db.prepare('SELECT * FROM site_tokens').all())).not.toContain(A);
  });

  it('legacy env token becomes a normal passdesk token with env defaults', () => {
    boot(config);
    const p = registry(config).resolveToken(LEGACY)!;
    expect(p).toMatchObject({ clientId: 'passdesk', source: 'passdesk', defaultModel: config.OPENROUTER_MODEL, allowedModels: ['*'] });
    expect(p.tokenId).toBeTypeOf('number');
  });

  it('legacy token already claimed by the file stays with that client', () => {
    const cfg = { ...config, CLIENTS_CONFIG_PATH: writeClients([{ clientId: 'owner', tokens: [LEGACY] }]) };
    expect(boot(cfg).legacyTokenImported).toBe(false);
    expect(registry(cfg).resolveToken(LEGACY)!.clientId).toBe('owner');
    expect(repos.siteClients.get('passdesk')).toBeNull();
  });
});

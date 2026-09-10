import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DbHandle } from '../src/storage/db.js';
import { createRepos, type Repos } from '../src/storage/repos.js';
import { SecretBox } from '../src/storage/secret-box.js';
import { bootstrapSiteRegistry } from '../src/clients/site-bootstrap.js';
import { SiteRegistry } from '../src/clients/site-registry.js';
import { generateToken } from '../src/clients/tokens.js';
import { makeTestConfig } from './helpers/test-config.js';
import { capturingLogger } from './helpers/silent-logger.js';

const LEGACY = 'legacy-token-1234567890';

describe('SiteRegistry hot reload', () => {
  let dir: string;
  let handle: DbHandle;
  let repos: Repos;
  let reg: SiteRegistry;
  let clock: number;
  const secrets = new SecretBox('s'.repeat(32));
  const cap = capturingLogger();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proxy_llm-srr-'));
    handle = openDb(join(dir, 't.db'));
    repos = createRepos(handle.db);
    const config = makeTestConfig({ PROXY_INBOUND_TOKEN: LEGACY });
    bootstrapSiteRegistry({ db: handle.db, config, ...repos, secrets, logger: cap.logger });
    clock = 1_000_000;
    reg = new SiteRegistry({ config, ...repos, secrets, logger: cap.logger, now: () => clock, touchIntervalMs: 60_000 });
  });
  afterEach(() => {
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('revocation applies on reload; objects already handed out stay intact', () => {
    const before = reg.resolveToken(LEGACY)!;
    const tokenId = before.tokenId!;
    const extra = generateToken('site');
    repos.siteTokens.issue({ token_sha256: extra.sha256, token_prefix: extra.prefix, label: 'second', client_id: 'passdesk' }, 1);
    expect(reg.resolveToken(extra.plaintext)).toBeNull();

    repos.siteTokens.revoke(tokenId, 2);
    reg.reload();
    expect(reg.resolveToken(LEGACY)).toBeNull();
    expect(reg.resolveToken(extra.plaintext)!.clientId).toBe('passdesk');
    expect(before.clientId).toBe('passdesk');
  });

  it('disabling a client silences its tokens without revoking them', () => {
    repos.siteClients.update('passdesk', { enabled: 0 }, 1);
    expect(reg.reload().removed).toEqual(['passdesk']);
    expect(reg.resolveToken(LEGACY)).toBeNull();
    repos.siteClients.update('passdesk', { enabled: 1, max_concurrency: 4 }, 2);
    expect(reg.reload().added).toEqual(['passdesk']);
    expect(reg.resolveToken(LEGACY)!.maxConcurrency).toBe(4);
  });

  it('a snapshot that cannot be built leaves the previous one in force', () => {
    handle.db.prepare(`UPDATE site_clients SET allowed_models_json = '{oops' WHERE client_id = 'passdesk'`).run();
    expect(() => reg.reload()).toThrow(/allowed_models_json/);
    expect(reg.resolveToken(LEGACY)!.clientId).toBe('passdesk');
  });

  it('prepare-then-publish: a failed transaction publishes nothing', () => {
    const id = reg.resolveToken(LEGACY)!.tokenId!;
    expect(() =>
      handle.db.transaction(() => {
        repos.siteTokens.revoke(id, 1);
        reg.buildSnapshot();
        throw new Error('audit write failed');
      })(),
    ).toThrow('audit write failed');
    expect(repos.siteTokens.get(id)!.revoked_at).toBeNull();
    expect(reg.resolveToken(LEGACY)).not.toBeNull();
  });

  it('last_used_at is throttled per token', () => {
    const id = reg.resolveToken(LEGACY)!.tokenId!;
    expect(repos.siteTokens.get(id)!.last_used_at).toBe(clock);
    clock += 30_000;
    reg.resolveToken(LEGACY);
    expect(repos.siteTokens.get(id)!.last_used_at).toBe(clock - 30_000);
    clock += 31_000;
    reg.resolveToken(LEGACY);
    expect(repos.siteTokens.get(id)!.last_used_at).toBe(clock);
  });
});

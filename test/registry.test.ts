import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadClientRegistry, ClientRegistryError } from '../src/clients/registry.js';
import { makeTestConfig } from './helpers/test-config.js';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('ClientRegistry', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'proxy_llm-reg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeClients = (obj: unknown): string => {
    const p = join(dir, 'clients.json');
    writeFileSync(p, JSON.stringify(obj), 'utf8');
    return p;
  };

  it('no config path → legacy client from PROXY_INBOUND_TOKEN', () => {
    const config = makeTestConfig({ PROXY_INBOUND_TOKEN: 'legacy-token-1234567890', CLIENTS_CONFIG_PATH: undefined });
    const reg = loadClientRegistry(config);
    const c = reg.resolveToken('legacy-token-1234567890');
    expect(c?.clientId).toBe('passdesk');
    expect(c?.allowedModels).toEqual([]); // legacy форсит дефолт-модель
    expect(reg.resolveToken('nope-nope-nope-1234')).toBeNull();
  });

  it('explicit path but missing file → fail-fast', () => {
    const config = makeTestConfig({ CLIENTS_CONFIG_PATH: join(dir, 'does-not-exist.json') });
    expect(() => loadClientRegistry(config)).toThrow(ClientRegistryError);
  });

  it('invalid JSON → fail-fast', () => {
    const p = join(dir, 'clients.json');
    writeFileSync(p, '{ not json', 'utf8');
    const config = makeTestConfig({ CLIENTS_CONFIG_PATH: p });
    expect(() => loadClientRegistry(config)).toThrow(ClientRegistryError);
  });

  it('resolves plaintext and tokenSha256; legacy token still resolves', () => {
    const path = writeClients({
      clients: [
        { clientId: 'alpha', tokens: ['alpha-token-1234567890'], defaultModel: 'a/model' },
        { clientId: 'beta', tokenSha256: [sha256('beta-token-1234567890')], allowedModels: ['b/one', 'b/two'] },
      ],
    });
    const config = makeTestConfig({ PROXY_INBOUND_TOKEN: 'legacy-token-1234567890', CLIENTS_CONFIG_PATH: path });
    const reg = loadClientRegistry(config);
    expect(reg.resolveToken('alpha-token-1234567890')?.clientId).toBe('alpha');
    expect(reg.resolveToken('beta-token-1234567890')?.clientId).toBe('beta');
    expect(reg.resolveToken('legacy-token-1234567890')?.clientId).toBe('passdesk');
    expect(reg.resolveToken('unknown-token-000000000')).toBeNull();
    // уникальные клиенты для предсоздания очередей: alpha, beta, passdesk
    expect(reg.clients().map((c) => c.clientId).sort()).toEqual(['alpha', 'beta', 'passdesk']);
  });

  it('rejects duplicate clientId', () => {
    const path = writeClients({
      clients: [
        { clientId: 'dup', tokens: ['tok-one-1234567890abc'] },
        { clientId: 'dup', tokens: ['tok-two-1234567890abc'] },
      ],
    });
    const config = makeTestConfig({ CLIENTS_CONFIG_PATH: path });
    expect(() => loadClientRegistry(config)).toThrow(/дублирующийся clientId/);
  });

  it('rejects duplicate token hash across clients', () => {
    const shared = 'shared-token-1234567890';
    const path = writeClients({
      clients: [
        { clientId: 'a', tokens: [shared] },
        { clientId: 'b', tokenSha256: [sha256(shared)] },
      ],
    });
    const config = makeTestConfig({ CLIENTS_CONFIG_PATH: path });
    expect(() => loadClientRegistry(config)).toThrow(/дублирующийся токен/);
  });
});

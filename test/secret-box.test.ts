import { describe, expect, it } from 'vitest';
import { SecretBox, SecretBoxError } from '../src/storage/secret-box.js';
import { resolvePayer } from '../src/billing/payer.js';
import type { ClientConfig } from '../src/clients/registry.js';

const K1 = 'k'.repeat(32);
const K2 = 'another-key-material-0123456789abcdef';

describe('SecretBox', () => {
  it('roundtrips and uses a fresh IV per value', () => {
    const box = new SecretBox(K1);
    const a = box.seal('sk-or-v1-secret');
    const b = box.seal('sk-or-v1-secret');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.')).toBe(true);
    expect(a).not.toContain('sk-or');
    expect(box.open(a)).toBe('sk-or-v1-secret');
    expect(box.open(b)).toBe('sk-or-v1-secret');
  });

  it('handles empty and non-ASCII values', () => {
    const box = new SecretBox(K1);
    expect(box.open(box.seal(''))).toBe('');
    expect(box.open(box.seal('ключ-🔑'))).toBe('ключ-🔑');
  });

  it('refuses to open with a different key', () => {
    const sealed = new SecretBox(K1).seal('x');
    expect(() => new SecretBox(K2).open(sealed)).toThrow(SecretBoxError);
  });

  it('detects tampering instead of returning garbage', () => {
    const box = new SecretBox(K1);
    const parts = box.seal('payload-payload').split('.');
    const tag = parts[3]!;
    parts[3] = (tag[0] === 'A' ? 'B' : 'A') + tag.slice(1);
    expect(() => box.open(parts.join('.'))).toThrow(SecretBoxError);
  });

  it('rejects malformed values and short key material', () => {
    const box = new SecretBox(K1);
    expect(() => box.open('plain-text-key')).toThrow(SecretBoxError);
    expect(() => box.open('v2.a.b.c')).toThrow(SecretBoxError);
    expect(() => new SecretBox('short')).toThrow(SecretBoxError);
  });

  it('reseals a value under a new key (rekey)', () => {
    const oldBox = new SecretBox(K1);
    const newBox = new SecretBox(K2);
    const moved = newBox.reseal(oldBox.seal('secret'), oldBox);
    expect(newBox.open(moved)).toBe('secret');
    expect(() => oldBox.open(moved)).toThrow(SecretBoxError);
  });

  it('fingerprint matches the payer formula used in billing_attempts.api_key_fp', () => {
    const client = { clientId: 'a', openrouterApiKey: 'sk-or-x' } as ClientConfig;
    expect(SecretBox.fingerprint('sk-or-x')).toBe(resolvePayer(client, 'global').fingerprint);
    expect(SecretBox.fingerprint('sk-or-x')).toMatch(/^[0-9a-f]{16}$/);
  });
});

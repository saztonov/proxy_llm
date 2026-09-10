import { describe, expect, it } from 'vitest';
import { generateToken, looksLikeToken, sha256Hex, TOKEN_PREFIX } from '../src/clients/tokens.js';

describe('tokens', () => {
  it('generates 128-bit tokens with a contour prefix', () => {
    const t = generateToken('agent');
    expect(t.plaintext).toMatch(/^pl_agent_[0-9a-f]{32}$/);
    expect(t.sha256).toBe(sha256Hex(t.plaintext));
    expect(t.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(t.prefix).toBe(t.plaintext.slice(0, TOKEN_PREFIX.agent.length + 6));
    expect(generateToken('site').plaintext).toMatch(/^pl_site_[0-9a-f]{32}$/);
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateToken('site').plaintext));
    expect(seen.size).toBe(200);
  });

  it('recognizes its own format only', () => {
    expect(looksLikeToken('agent', generateToken('agent').plaintext)).toBe(true);
    expect(looksLikeToken('agent', generateToken('site').plaintext)).toBe(false);
    expect(looksLikeToken('site', 'pl_site_XYZ')).toBe(false);
    expect(looksLikeToken('site', 'test-token-1234567890abcdef')).toBe(false);
  });
});

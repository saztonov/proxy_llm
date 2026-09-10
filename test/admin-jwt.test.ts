import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { deriveAdminKeys } from '../src/admin/auth/keys.js';
import { signAccessToken, verifyAccessToken, JWT_ISS, JWT_AUD } from '../src/admin/auth/jwt.js';

const KEY = deriveAdminKeys('unit-test-admin-secret').jwt;
const OTHER_KEY = deriveAdminKeys('another-secret').jwt;
const NOW_MS = 1_700_000_000_000;
const NOW_SEC = NOW_MS / 1000;

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** Собирает токен с произвольным заголовком/payload и ВАЛИДНОЙ HS256-подписью ключом key. */
function forge(key: Buffer, header: unknown, payload: unknown): string {
  const input = `${b64url(header)}.${b64url(payload)}`;
  const sig = createHmac('sha256', key).update(input).digest('base64url');
  return `${input}.${sig}`;
}

const HS256_HEADER = { alg: 'HS256', typ: 'JWT' };

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { sub: 1, sid: 'sid-1', iat: NOW_SEC, exp: NOW_SEC + 600, iss: JWT_ISS, aud: JWT_AUD, ...overrides };
}

describe('deriveAdminKeys', () => {
  it('derives two distinct deterministic 32-byte keys', () => {
    const a = deriveAdminKeys('secret-1');
    const b = deriveAdminKeys('secret-1');
    expect(a.jwt.length).toBe(32);
    expect(a.csrf.length).toBe(32);
    expect(a.jwt.equals(b.jwt)).toBe(true);
    expect(a.csrf.equals(b.csrf)).toBe(true);
    expect(a.jwt.equals(a.csrf)).toBe(false);
    expect(deriveAdminKeys('secret-2').jwt.equals(a.jwt)).toBe(false);
  });

  it('throws on empty secret', () => {
    expect(() => deriveAdminKeys('')).toThrow();
  });
});

describe('admin JWT (HS256)', () => {
  it('roundtrips sign → verify', () => {
    const token = signAccessToken(KEY, { sub: 7, sid: 'abc' }, 900, NOW_MS);
    expect(token.split('.')).toHaveLength(3);
    const parsed = verifyAccessToken(KEY, token, NOW_MS + 1000);
    expect(parsed).toEqual({
      sub: 7,
      sid: 'abc',
      iat: NOW_SEC,
      exp: NOW_SEC + 900,
      iss: JWT_ISS,
      aud: JWT_AUD,
    });
  });

  it('rejects a token signed with a different key', () => {
    const token = signAccessToken(OTHER_KEY, { sub: 1, sid: 'x' }, 900, NOW_MS);
    expect(verifyAccessToken(KEY, token, NOW_MS)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const token = signAccessToken(KEY, { sub: 1, sid: 'x' }, 900, NOW_MS);
    const [h, , s] = token.split('.');
    const tampered = `${h}.${b64url(claims({ sub: 999, sid: 'x' }))}.${s}`;
    expect(verifyAccessToken(KEY, tampered, NOW_MS)).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const token = signAccessToken(KEY, { sub: 1, sid: 'x' }, 900, NOW_MS);
    const [h, p, s] = token.split('.');
    const flipped = s.endsWith('A') ? `${s.slice(0, -1)}B` : `${s.slice(0, -1)}A`;
    expect(verifyAccessToken(KEY, `${h}.${p}.${flipped}`, NOW_MS)).toBeNull();
    expect(verifyAccessToken(KEY, `${h}.${p}.`, NOW_MS)).toBeNull();
    expect(verifyAccessToken(KEY, `${h}.${p}.${s}x`, NOW_MS)).toBeNull();
  });

  it('rejects expired tokens (exp <= now)', () => {
    const token = signAccessToken(KEY, { sub: 1, sid: 'x' }, 60, NOW_MS);
    expect(verifyAccessToken(KEY, token, NOW_MS + 59_000)).not.toBeNull();
    expect(verifyAccessToken(KEY, token, NOW_MS + 60_000)).toBeNull();
    expect(verifyAccessToken(KEY, token, NOW_MS + 61_000)).toBeNull();
    const zeroTtl = signAccessToken(KEY, { sub: 1, sid: 'x' }, 0, NOW_MS);
    expect(verifyAccessToken(KEY, zeroTtl, NOW_MS)).toBeNull();
  });

  it('rejects alg=none even with a valid HMAC over the input', () => {
    expect(verifyAccessToken(KEY, forge(KEY, { alg: 'none' }, claims()), NOW_MS)).toBeNull();
    expect(verifyAccessToken(KEY, forge(KEY, { alg: 'none', typ: 'JWT' }, claims()), NOW_MS)).toBeNull();
    const [h, p] = forge(KEY, { alg: 'none', typ: 'JWT' }, claims()).split('.');
    expect(verifyAccessToken(KEY, `${h}.${p}.`, NOW_MS)).toBeNull();
  });

  it('rejects algorithm confusion (HS512 header with a valid HS256 signature)', () => {
    const token = forge(KEY, { alg: 'HS512', typ: 'JWT' }, claims());
    expect(verifyAccessToken(KEY, token, NOW_MS)).toBeNull();
    const rs = forge(KEY, { alg: 'RS256', typ: 'JWT' }, claims());
    expect(verifyAccessToken(KEY, rs, NOW_MS)).toBeNull();
    // даже перестановка полей заголовка не проходит: сравнение строгое, по строке
    const reordered = forge(KEY, { typ: 'JWT', alg: 'HS256' }, claims());
    expect(verifyAccessToken(KEY, reordered, NOW_MS)).toBeNull();
    // контроль: та же forge с нашим заголовком принимается
    expect(verifyAccessToken(KEY, forge(KEY, HS256_HEADER, claims()), NOW_MS)).not.toBeNull();
  });

  it('rejects foreign iss / aud', () => {
    expect(verifyAccessToken(KEY, forge(KEY, HS256_HEADER, claims({ iss: 'other' })), NOW_MS)).toBeNull();
    expect(verifyAccessToken(KEY, forge(KEY, HS256_HEADER, claims({ aud: 'user' })), NOW_MS)).toBeNull();
    expect(verifyAccessToken(KEY, forge(KEY, HS256_HEADER, claims({ aud: ['admin'] })), NOW_MS)).toBeNull();
  });

  it('rejects iat from the future beyond the skew allowance', () => {
    const future = forge(KEY, HS256_HEADER, claims({ iat: NOW_SEC + 120, exp: NOW_SEC + 720 }));
    expect(verifyAccessToken(KEY, future, NOW_MS)).toBeNull();
    const withinSkew = forge(KEY, HS256_HEADER, claims({ iat: NOW_SEC + 30, exp: NOW_SEC + 630 }));
    expect(verifyAccessToken(KEY, withinSkew, NOW_MS)).not.toBeNull();
  });

  it('rejects malformed claim types', () => {
    expect(verifyAccessToken(KEY, forge(KEY, HS256_HEADER, claims({ sub: '1' })), NOW_MS)).toBeNull();
    expect(verifyAccessToken(KEY, forge(KEY, HS256_HEADER, claims({ sid: 42 })), NOW_MS)).toBeNull();
    expect(verifyAccessToken(KEY, forge(KEY, HS256_HEADER, claims({ exp: 'never' })), NOW_MS)).toBeNull();
    expect(verifyAccessToken(KEY, forge(KEY, HS256_HEADER, claims({ exp: undefined })), NOW_MS)).toBeNull();
    expect(verifyAccessToken(KEY, forge(KEY, HS256_HEADER, claims({ iat: 'now' })), NOW_MS)).toBeNull();
    expect(verifyAccessToken(KEY, forge(KEY, HS256_HEADER, [1, 2, 3]), NOW_MS)).toBeNull();
    expect(verifyAccessToken(KEY, forge(KEY, HS256_HEADER, null), NOW_MS)).toBeNull();
  });

  it('rejects a payload that is not JSON (with a valid signature)', () => {
    const header = b64url(HS256_HEADER);
    const payload = Buffer.from('{not json', 'utf8').toString('base64url');
    const input = `${header}.${payload}`;
    const sig = createHmac('sha256', KEY).update(input).digest('base64url');
    expect(verifyAccessToken(KEY, `${input}.${sig}`, NOW_MS)).toBeNull();
  });

  it('rejects tokens with the wrong number of parts', () => {
    const token = signAccessToken(KEY, { sub: 1, sid: 'x' }, 900, NOW_MS);
    const [h, p, s] = token.split('.');
    expect(verifyAccessToken(KEY, `${h}.${p}`, NOW_MS)).toBeNull();
    expect(verifyAccessToken(KEY, `${h}.${p}.${s}.extra`, NOW_MS)).toBeNull();
    expect(verifyAccessToken(KEY, '', NOW_MS)).toBeNull();
    expect(verifyAccessToken(KEY, undefined as unknown as string, NOW_MS)).toBeNull();
  });

  it('does not leak extra claims from the token', () => {
    const token = forge(KEY, HS256_HEADER, claims({ role: 'superuser' }));
    const parsed = verifyAccessToken(KEY, token, NOW_MS);
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sid', 'sub']);
  });
});

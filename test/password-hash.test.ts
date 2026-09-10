import { describe, it, expect } from 'vitest';
import { randomBytes, scryptSync } from 'node:crypto';
import {
  hashPassword,
  verifyPassword,
  needsRehash,
  validateNewPassword,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  SCRYPT_PARAMS,
} from '../src/admin/auth/password.js';

const PASSWORD = 'correct horse battery staple';
const FORMAT_RE = /^scrypt\$32768\$8\$3\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/;

describe('password hashing (scrypt)', () => {
  it('produces the expected format, verifies and does not need rehash', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(stored).toMatch(FORMAT_RE);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyPassword('wrong password 12345', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
    expect(needsRehash(stored)).toBe(false);
  });

  it('uses a fresh salt each time', async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toBe(b);
    expect(a.split('$')[4]).not.toBe(b.split('$')[4]);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(PASSWORD, b)).toBe(true);
  });

  it('needsRehash is true for older params', async () => {
    const stored = await hashPassword(PASSWORD);
    expect(needsRehash(stored.replace('$32768$', '$16384$'))).toBe(true);
    expect(needsRehash(stored.replace('$8$3$', '$8$1$'))).toBe(true);
  });

  it('verifies legacy hashes with weaker params taken from the string', async () => {
    const salt = randomBytes(16);
    const hash = scryptSync(PASSWORD, salt, 32, { N: 4096, r: 8, p: 1 });
    const legacy = ['scrypt', 4096, 8, 1, salt.toString('base64url'), hash.toString('base64url')].join('$');
    expect(await verifyPassword(PASSWORD, legacy)).toBe(true);
    expect(await verifyPassword('not it, definitely', legacy)).toBe(false);
    expect(needsRehash(legacy)).toBe(true);
  });

  it('treats NFC and NFD forms of the same password as equal', async () => {
    const composed = 'café-latte-12345';
    const decomposed = 'café-latte-12345';
    expect(composed).not.toBe(decomposed);
    const stored = await hashPassword(composed);
    expect(await verifyPassword(decomposed, stored)).toBe(true);
    const stored2 = await hashPassword(decomposed);
    expect(await verifyPassword(composed, stored2)).toBe(true);
  });

  it('rejects passwords over MAX_PASSWORD_BYTES', async () => {
    const tooLongAscii = 'a'.repeat(MAX_PASSWORD_BYTES + 1);
    await expect(hashPassword(tooLongAscii)).rejects.toBeInstanceOf(RangeError);
    // 600 кириллических символов = 1200 байт UTF-8 при 600 символах
    const tooLongUtf8 = 'я'.repeat(600);
    expect(Buffer.byteLength(tooLongUtf8, 'utf8')).toBeGreaterThan(MAX_PASSWORD_BYTES);
    await expect(hashPassword(tooLongUtf8)).rejects.toBeInstanceOf(RangeError);

    const stored = await hashPassword(PASSWORD);
    expect(await verifyPassword(tooLongAscii, stored)).toBe(false);
    expect(await verifyPassword(tooLongUtf8, stored)).toBe(false);
  });

  it('never throws on garbage stored strings', async () => {
    const garbage = [
      '',
      'not-a-hash',
      'scrypt',
      'scrypt$abc$8$3$salt$hash',
      'scrypt$32768$8$3$$',
      'scrypt$32768$8$3$c2FsdA$aGFzaA', // соль и хэш короче допустимого
      'scrypt$32768$8$3$c2Fs dA$aGFzaA', // недопустимые символы
      'bcrypt$32768$8$3$' + 'A'.repeat(22) + '$' + 'B'.repeat(43),
      'scrypt$32768$8$3$' + 'A'.repeat(22) + '$' + 'B'.repeat(43) + '$extra',
    ];
    for (const s of garbage) {
      expect(await verifyPassword(PASSWORD, s)).toBe(false);
      expect(needsRehash(s)).toBe(true);
    }
    // не-строки тоже не роняют
    expect(await verifyPassword(PASSWORD, undefined as unknown as string)).toBe(false);
    expect(needsRehash(null as unknown as string)).toBe(true);
  });

  it('refuses to compute hashes with oversized or invalid N', async () => {
    const stored = await hashPassword(PASSWORD);
    const hugeN = stored.replace('$32768$', `$${2 ** 20}$`);
    expect(await verifyPassword(PASSWORD, hugeN)).toBe(false);
    expect(needsRehash(hugeN)).toBe(true);
    // N не степень двойки
    expect(await verifyPassword(PASSWORD, stored.replace('$32768$', '$30000$'))).toBe(false);
    // N = 1 недопустим для scrypt
    expect(await verifyPassword(PASSWORD, stored.replace('$32768$', '$1$'))).toBe(false);
    // гигантский p при допустимом N → превышение бюджета работы
    expect(await verifyPassword(PASSWORD, stored.replace('$8$3$', '$8$1000$'))).toBe(false);
  });

  it('validateNewPassword enforces min length and max bytes', async () => {
    expect(validateNewPassword('short')).toEqual(expect.any(String));
    expect(validateNewPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toEqual(expect.any(String));
    expect(validateNewPassword('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
    expect(validateNewPassword('a'.repeat(MAX_PASSWORD_BYTES))).toBeNull();
    expect(validateNewPassword('a'.repeat(MAX_PASSWORD_BYTES + 1))).toEqual(expect.any(String));
    await expect(hashPassword('short')).rejects.toBeInstanceOf(RangeError);
  });

  it('exposes the documented scrypt parameters', () => {
    expect(SCRYPT_PARAMS).toEqual({ N: 32768, r: 8, p: 3, keylen: 32, maxmem: 64 * 1024 * 1024 });
    expect(128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r).toBeLessThan(SCRYPT_PARAMS.maxmem);
  });
});

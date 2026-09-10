import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Память scrypt ≈ 128·N·r = 32 МиБ. Дефолтный maxmem в Node — ровно 32 МиБ,
 * т.е. граница; задаём явно с запасом, чтобы не ловить ERR_CRYPTO_INVALID_SCRYPT_PARAMS.
 */
export const SCRYPT_PARAMS = {
  N: 32768,
  r: 8,
  p: 3,
  keylen: 32,
  maxmem: 64 * 1024 * 1024,
} as const;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_BYTES = 1024;

const ALGO = 'scrypt';
const SALT_BYTES = 16;
/** Разумные границы длины соли/хэша из строки — отсев мусорных значений. */
const MIN_SALT_BYTES = 8;
const MAX_SALT_BYTES = 64;
const MIN_HASH_BYTES = 16;
const MAX_HASH_BYTES = 64;
/**
 * Верхняя граница CPU-работы для хэша из строки: N*r*p не больше, чем у
 * текущих параметров. Вместе с ограничением N <= SCRYPT_PARAMS.N это не даёт
 * подсунуть хэш с гигантскими параметрами и получить DoS на verify.
 */
const MAX_WORK = SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * SCRYPT_PARAMS.p;

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const POSITIVE_INT_RE = /^[1-9][0-9]*$/;

function parsePositiveInt(s: string): number | null {
  if (!POSITIVE_INT_RE.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function isPowerOfTwo(n: number): boolean {
  return n > 1 && (n & (n - 1)) === 0;
}

function decodeBase64Url(s: string, min: number, max: number): Buffer | null {
  if (!BASE64URL_RE.test(s)) return null;
  const buf = Buffer.from(s, 'base64url');
  if (buf.length < min || buf.length > max) return null;
  return buf;
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

/** Разбор 'scrypt$N$r$p$<salt b64url>$<hash b64url>' с проверкой границ. null — строка непригодна. */
function parseStored(stored: unknown): ParsedHash | null {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== ALGO) return null;
  const N = parsePositiveInt(parts[1]);
  const r = parsePositiveInt(parts[2]);
  const p = parsePositiveInt(parts[3]);
  if (N === null || r === null || p === null) return null;
  if (!isPowerOfTwo(N) || N > SCRYPT_PARAMS.N) return null;
  if (N * r * p > MAX_WORK) return null;
  const salt = decodeBase64Url(parts[4], MIN_SALT_BYTES, MAX_SALT_BYTES);
  const hash = decodeBase64Url(parts[5], MIN_HASH_BYTES, MAX_HASH_BYTES);
  if (salt === null || hash === null) return null;
  return { N, r, p, salt, hash };
}

/**
 * Возвращает текст ошибки или null. Проверки: длина >= MIN_PASSWORD_LENGTH
 * символов (code points после NFC), <= MAX_PASSWORD_BYTES байт в UTF-8.
 */
export function validateNewPassword(password: string): string | null {
  if (typeof password !== 'string') return 'пароль должен быть строкой';
  const normalized = password.normalize('NFC');
  let chars = 0;
  for (const _ of normalized) chars++;
  if (chars < MIN_PASSWORD_LENGTH) {
    return `пароль короче ${MIN_PASSWORD_LENGTH} символов`;
  }
  if (Buffer.byteLength(normalized, 'utf8') > MAX_PASSWORD_BYTES) {
    return `пароль длиннее ${MAX_PASSWORD_BYTES} байт`;
  }
  return null;
}

/**
 * 'scrypt$N$r$p$<salt b64url>$<hash b64url>'. Пароль нормализуется NFC
 * (предсоставленная и составная формы одного символа — один пароль).
 * Бросает RangeError, если validateNewPassword вернул ошибку. Соль — 16 случайных байт.
 */
export async function hashPassword(password: string): Promise<string> {
  const err = validateNewPassword(password);
  if (err !== null) throw new RangeError(err);
  const normalized = password.normalize('NFC');
  const salt = randomBytes(SALT_BYTES);
  const { N, r, p, keylen, maxmem } = SCRYPT_PARAMS;
  const hash = await scryptAsync(normalized, salt, keylen, { N, r, p, maxmem });
  return [ALGO, N, r, p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/**
 * false при любой проблеме (битая строка, неверные параметры, пустой или
 * слишком длинный пароль) — НЕ бросает. Параметры N/r/p берутся из строки,
 * чтобы старые хэши продолжали проверяться; границы см. parseStored.
 * Сравнение timingSafeEqual после проверки длин.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    if (typeof password !== 'string' || password.length === 0) return false;
    const normalized = password.normalize('NFC');
    if (Buffer.byteLength(normalized, 'utf8') > MAX_PASSWORD_BYTES) return false;
    const parsed = parseStored(stored);
    if (parsed === null) return false;
    const derived = await scryptAsync(normalized, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: SCRYPT_PARAMS.maxmem,
    });
    return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
  } catch {
    return false;
  }
}

/**
 * true, если N/r/p/keylen в строке отличаются от SCRYPT_PARAMS — пора
 * перехэшировать при успешном логине. Битая строка → true.
 */
export function needsRehash(stored: string): boolean {
  const parsed = parseStored(stored);
  if (parsed === null) return true;
  return (
    parsed.N !== SCRYPT_PARAMS.N ||
    parsed.r !== SCRYPT_PARAMS.r ||
    parsed.p !== SCRYPT_PARAMS.p ||
    parsed.hash.length !== SCRYPT_PARAMS.keylen
  );
}

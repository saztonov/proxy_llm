import { createHmac, timingSafeEqual } from 'node:crypto';

export const JWT_ISS = 'proxy_llm-admin';
export const JWT_AUD = 'admin';

export interface AccessClaims {
  /** id администратора */
  sub: number;
  /** id сессии (для отзыва и привязки CSRF-токена) */
  sid: string;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

/**
 * Единственный допустимый заголовок. Сравнивается как строка целиком —
 * это закрывает alg=none и любую подмену алгоритма (HS512, RS256 и т.п.):
 * токен с другим заголовком отбрасывается до проверки подписи.
 */
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString(
  'base64url',
);

/** Допустимое опережение iat относительно наших часов (сек). */
const MAX_IAT_SKEW_SEC = 60;

function hmac(key: Buffer, signingInput: string): string {
  return createHmac('sha256', key).update(signingInput, 'utf8').digest('base64url');
}

export function signAccessToken(
  key: Buffer,
  c: { sub: number; sid: string },
  ttlSec: number,
  nowMs = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const claims: AccessClaims = {
    sub: c.sub,
    sid: c.sid,
    iat,
    exp: iat + ttlSec,
    iss: JWT_ISS,
    aud: JWT_AUD,
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const input = `${HEADER}.${payload}`;
  return `${input}.${hmac(key, input)}`;
}

/**
 * null при ЛЮБОЙ ошибке: не 3 части, чужой заголовок, подпись не совпала
 * (timingSafeEqual после сравнения длин), payload не JSON-объект, iss/aud не
 * наши, sub не number, sid не string, exp не number или exp <= now,
 * iat не number или iat > now + MAX_IAT_SKEW_SEC.
 */
export function verifyAccessToken(
  key: Buffer,
  token: string,
  nowMs = Date.now(),
): AccessClaims | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (header !== HEADER) return null;

  // Подпись сравнивается в канонической base64url-форме (без padding),
  // как строка байт: любая вариация кодирования → несовпадение.
  const expected = Buffer.from(hmac(key, `${header}.${payload}`), 'utf8');
  const presented = Buffer.from(signature, 'utf8');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const c = parsed as Record<string, unknown>;

  if (c.iss !== JWT_ISS || c.aud !== JWT_AUD) return null;
  if (typeof c.sub !== 'number' || !Number.isFinite(c.sub)) return null;
  if (typeof c.sid !== 'string') return null;
  if (typeof c.exp !== 'number' || !Number.isFinite(c.exp)) return null;
  if (typeof c.iat !== 'number' || !Number.isFinite(c.iat)) return null;

  const now = Math.floor(nowMs / 1000);
  if (c.exp <= now) return null;
  if (c.iat > now + MAX_IAT_SKEW_SEC) return null;

  // Возвращаем только известные поля — лишние claims из токена дальше не протекают.
  return { sub: c.sub, sid: c.sid, iat: c.iat, exp: c.exp, iss: JWT_ISS, aud: JWT_AUD };
}

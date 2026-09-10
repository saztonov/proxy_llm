import { createHash, randomBytes } from 'node:crypto';

export type TokenKind = 'site' | 'agent';

/** Префикс типа: по нему видно, для какого контура токен, и его ловят сканеры секретов. */
export const TOKEN_PREFIX: Readonly<Record<TokenKind, string>> = {
  site: 'pl_site_',
  agent: 'pl_agent_',
};

/** Случайная часть: 16 байт = 128 бит, перебор невозможен. */
const TOKEN_RANDOM_BYTES = 16;
/** Сколько символов случайной части показывать в интерфейсе (24 бита из 128). */
const VISIBLE_RANDOM_CHARS = 6;

export interface IssuedToken {
  /** Открытый текст — отдаётся ровно один раз, в БД не хранится. */
  plaintext: string;
  sha256: string;
  /** Для отображения: 'pl_agent_a1b2c3'. */
  prefix: string;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function generateToken(kind: TokenKind): IssuedToken {
  const plaintext = TOKEN_PREFIX[kind] + randomBytes(TOKEN_RANDOM_BYTES).toString('hex');
  return {
    plaintext,
    sha256: sha256Hex(plaintext),
    prefix: plaintext.slice(0, TOKEN_PREFIX[kind].length + VISIBLE_RANDOM_CHARS),
  };
}

/** Формат, который выдаёт generateToken (для быстрого отказа до lookup). */
export function looksLikeToken(kind: TokenKind, value: string): boolean {
  const p = TOKEN_PREFIX[kind];
  return value.length === p.length + TOKEN_RANDOM_BYTES * 2 && value.startsWith(p) && /^[0-9a-f]+$/.test(value.slice(p.length));
}

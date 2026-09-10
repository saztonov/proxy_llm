import { hkdfSync } from 'node:crypto';

export interface AdminKeys {
  /** Ключ подписи access-токенов (HS256). */
  jwt: Buffer;
  /** Ключ HMAC для CSRF-токенов. */
  csrf: Buffer;
}

const KEY_LENGTH = 32;
const EMPTY_SALT = Buffer.alloc(0);
const INFO_JWT = 'proxy_llm/admin/jwt/v1';
const INFO_CSRF = 'proxy_llm/admin/csrf/v1';

/**
 * Один секрет из env → независимые 32-байтовые ключи через HKDF-SHA256.
 * Domain separation обеспечивает параметр info: утечка одного производного
 * ключа ничего не говорит ни о другом, ни о самом секрете.
 * Пустой секрет → throw (иначе ключи были бы предсказуемы).
 */
export function deriveAdminKeys(secret: string): AdminKeys {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('admin secret must be a non-empty string');
  }
  const ikm = Buffer.from(secret, 'utf8');
  return {
    jwt: Buffer.from(hkdfSync('sha256', ikm, EMPTY_SALT, INFO_JWT, KEY_LENGTH)),
    csrf: Buffer.from(hkdfSync('sha256', ikm, EMPTY_SALT, INFO_CSRF, KEY_LENGTH)),
  };
}

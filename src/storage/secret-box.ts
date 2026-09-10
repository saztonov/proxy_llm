import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretBoxError extends Error {
  override readonly name = 'SecretBoxError';
}

/**
 * Шифрование секретов, которые хранятся в SQLite: ключи провайдеров, пер-клиентские ключи
 * OpenRouter, секретные заголовки провайдеров.
 *
 * Зачем, если БД и .env лежат на одной машине: БД копируется — ночные бэкапы, `sqlite3
 * prod.db` при отладке, выгрузка на локальную машину. Ключ шифрования остаётся в
 * /etc/proxy_llm/.env (та же зона доверия, где OPENROUTER_API_KEY), и файл БД или бэкап сам
 * по себе ключей не раскрывает.
 *
 * AES-256-GCM даёт и конфиденциальность, и целостность: подменённый в БД шифртекст не
 * расшифруется вовсе, а не превратится в правдоподобный мусор.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(keyMaterial: string) {
    if (keyMaterial.length < 32) {
      throw new SecretBoxError('encryption key material must be at least 32 chars');
    }
    this.key = createHash('sha256').update(keyMaterial, 'utf8').digest();
  }

  /** 'v1.<iv>.<ciphertext>.<tag>' (base64url). Каждое значение — со своим случайным IV. */
  seal(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_BYTES });
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), ct.toString('base64url'), tag.toString('base64url')].join('.');
  }

  open(sealed: string): string {
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new SecretBoxError('unsupported sealed value format');
    }
    const iv = Buffer.from(parts[1]!, 'base64url');
    const ct = Buffer.from(parts[2]!, 'base64url');
    const tag = Buffer.from(parts[3]!, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new SecretBoxError('corrupted sealed value');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_BYTES });
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      throw new SecretBoxError('cannot decrypt: wrong SECRETS_ENCRYPTION_KEY or corrupted value');
    }
  }

  /** Перешифровать значение, запечатанное другим ключом (ротация SECRETS_ENCRYPTION_KEY). */
  reseal(sealed: string, from: SecretBox): string {
    return this.seal(from.open(sealed));
  }

  /**
   * Отпечаток секрета: первые 16 hex от sha256. Та же формула, что в billing/payer.ts, поэтому
   * отпечаток ключа в справочнике сходится с api_key_fp в billing_attempts.
   */
  static fingerprint(plain: string): string {
    return createHash('sha256').update(plain, 'utf8').digest('hex').slice(0, 16);
  }
}

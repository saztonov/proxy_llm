import { createHash } from 'node:crypto';
import type { ClientConfig } from '../clients/registry.js';

/**
 * Кто платит за запрос.
 *
 * Boolean «свой ключ / общий ключ» не годится: он не различает аккаунты и не переживает
 * ротацию ключа. Отпечаток ключа делает и то и другое видимым — при смене ключа в отчёте
 * появляется новый fingerprint, и расхождение с инвойсом сразу объяснимо.
 */
export interface Payer {
  /** 'global' — общий OPENROUTER_API_KEY; иначе clientId владельца пер-клиентского ключа. */
  scope: string;
  /** Первые 16 hex от sha256(ключа). Односторонний и укороченный — сам ключ не восстановить. */
  fingerprint: string;
}

export function resolvePayer(client: ClientConfig, globalApiKey: string): Payer {
  const key = client.openrouterApiKey ?? globalApiKey;
  return {
    scope: client.openrouterApiKey ? client.clientId : 'global',
    fingerprint: createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16),
  };
}

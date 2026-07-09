import type { ClientConfig } from '../clients/registry.js';

export interface ModelResolution {
  model: string;
  fallbackModels: string[];
}

export type ResolveOutcome =
  | { ok: true; resolution: ModelResolution }
  | { ok: false; code: 'model_not_allowed'; allowed: string[] };

/**
 * Определяет эффективную модель для upstream-вызова.
 *
 * - Клиент прислал `model`, allowlist непустой, model входит → берём её, БЕЗ fallback-массива
 *   (уважаем явный выбор).
 * - Клиент прислал `model`, allowlist непустой, model НЕ входит → reject (fail closed): тихая
 *   подмена скрывала бы намерение и биллинг.
 * - allowlist пуст (legacy) → присланная модель игнорируется, используется дефолт (как сегодня).
 * - Модель не прислана → client.defaultModel (fallback только если непустой).
 */
export function resolveModel(
  requested: unknown,
  client: Pick<ClientConfig, 'defaultModel' | 'allowedModels' | 'fallbackModels'>,
): ResolveOutcome {
  const asked = typeof requested === 'string' && requested.length > 0 ? requested : undefined;

  if (asked !== undefined && client.allowedModels.length > 0) {
    if (client.allowedModels.includes(asked)) {
      return { ok: true, resolution: { model: asked, fallbackModels: [] } };
    }
    return { ok: false, code: 'model_not_allowed', allowed: client.allowedModels };
  }

  // legacy (пустой allowlist) или модель не прислана → дефолт клиента.
  return {
    ok: true,
    resolution: { model: client.defaultModel, fallbackModels: client.fallbackModels },
  };
}

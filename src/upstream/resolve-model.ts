import type { ClientConfig } from '../clients/registry.js';

export interface ModelResolution {
  model: string;
  fallbackModels: string[];
}

export type ResolveOutcome =
  | { ok: true; resolution: ModelResolution }
  | { ok: false; code: 'model_not_allowed'; allowed: string[] };

/**
 * Элемент allowlist'а, разрешающий любую модель OpenRouter.
 * Только точное `*`; префиксные глобы (`anthropic/*`) НЕ поддерживаются.
 */
export const ANY_MODEL = '*';

/**
 * Значения `model`, означающие «модель не выбираю».
 *
 * OpenAI SDK требует непустой `model`, поэтому клиент, которому модель безразлична, обязан
 * прислать хоть что-то. Заглушка должна означать «решай сам», а не уезжать в OpenRouter как
 * имя модели — иначе клиент на allowlist'е `["*"]` получил бы 400 от провайдера.
 *
 * Сравнение по всей строке, поэтому реальный слаг `openrouter/auto` заглушкой не считается.
 */
export const MODEL_SENTINELS: ReadonlySet<string> = new Set(['proxy', 'default', 'auto']);

/** `model` → запрошенный слаг, либо undefined = «клиент выбор не делал». */
function normalizeRequested(requested: unknown): string | undefined {
  if (typeof requested !== 'string') return undefined;
  const trimmed = requested.trim();
  if (trimmed.length === 0) return undefined;
  // Регистр гасим ТОЛЬКО для сравнения с заглушками: слаги OpenRouter регистрозависимы,
  // наружу модель уходит ровно как прислана.
  if (MODEL_SENTINELS.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

/**
 * Определяет эффективную модель для upstream-вызова.
 *
 * - Модель не прислана / заглушка / не строка → дефолт клиента + его fallback'и. Проверяется
 *   ПЕРВЫМ: при allowlist'е `["*"]` заглушка иначе уехала бы в OpenRouter как имя модели.
 * - allowlist пуст → присланная модель игнорируется, дефолт клиента (legacy-поведение; так
 *   оператор удерживает недоработанного клиента на старом поведении, см. registry.resolveEntry).
 * - allowlist содержит `*` либо саму модель → берём её, БЕЗ fallback-массива (уважаем явный
 *   выбор: тихий переезд на резервную модель скрыл бы от клиента и отказ, и смену биллинга).
 * - иначе → reject (fail closed): тихая подмена скрывала бы намерение и биллинг.
 */
export function resolveModel(
  requested: unknown,
  client: Pick<ClientConfig, 'defaultModel' | 'allowedModels' | 'fallbackModels'>,
): ResolveOutcome {
  const asked = normalizeRequested(requested);

  if (asked !== undefined && client.allowedModels.length > 0) {
    if (client.allowedModels.includes(ANY_MODEL) || client.allowedModels.includes(asked)) {
      return { ok: true, resolution: { model: asked, fallbackModels: [] } };
    }
    return { ok: false, code: 'model_not_allowed', allowed: client.allowedModels };
  }

  return {
    ok: true,
    resolution: { model: client.defaultModel, fallbackModels: client.fallbackModels },
  };
}

import type { ProxyResult } from '../upstream/openrouter-client.js';

export class ActiveDedupFullError extends Error {
  override readonly name = 'ActiveDedupFullError';
  constructor(readonly size: number, readonly cap: number) {
    super(`active dedup map is full: ${size}/${cap}`);
  }
}

/**
 * In-memory dedup активных запросов.
 *
 * Hard cap, БЕЗ LRU eviction: при заполненной Map новый ключ → ActiveDedupFullError
 * (вызывающий вернёт 503). LRU-eviction активного ключа создал бы второй upstream-вызов
 * при retry с тем же X-Idempotency-Key — это уничтожило бы смысл idempotency.
 */
interface ActiveEntry {
  promise: Promise<ProxyResult>;
  /** id фактического выполнения: присоединившиеся запросы ссылаются на него же. */
  executionId: string;
}

export class ActiveRequests {
  private readonly map = new Map<string, ActiveEntry>();

  constructor(private readonly cap: number) {}

  size(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): Promise<ProxyResult> | undefined {
    return this.map.get(key)?.promise;
  }

  /**
   * Регистрирует новый promise или присоединяется к существующему, сообщая, что именно
   * произошло.
   *
   * Признак join доступен ТОЛЬКО отсюда: снаружи между `has()` и регистрацией есть окно
   * гонки. Для биллинга это критично — присоединившийся запрос не порождает второго
   * обращения к OpenRouter, а значит и второго списания, и его нельзя считать как расход.
   *
   * @throws ActiveDedupFullError если ключ новый и Map уже заполнен.
   */
  registerOrJoinTracked(
    key: string,
    executionId: string,
    factory: () => Promise<ProxyResult>,
  ): { promise: Promise<ProxyResult>; joined: boolean; executionId: string } {
    const existing = this.map.get(key);
    // При join возвращаем id ЧУЖОГО выполнения: строка журнала присоединившегося запроса
    // должна указывать на те же billing_attempts, а не заводить собственное выполнение.
    if (existing) {
      return { promise: existing.promise, joined: true, executionId: existing.executionId };
    }

    if (this.map.size >= this.cap) {
      throw new ActiveDedupFullError(this.map.size, this.cap);
    }

    const promise = factory().finally(() => {
      this.map.delete(key);
    });
    this.map.set(key, { promise, executionId });
    return { promise, joined: false, executionId };
  }

  /**
   * Регистрирует новый promise или присоединяется к существующему.
   * @throws ActiveDedupFullError если ключ новый и Map уже заполнен.
   */
  registerOrJoin(
    key: string,
    factory: () => Promise<ProxyResult>,
  ): Promise<ProxyResult> {
    return this.registerOrJoinTracked(key, `legacy:${key}`, factory).promise;
  }
}

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
export class ActiveRequests {
  private readonly map = new Map<string, Promise<ProxyResult>>();

  constructor(private readonly cap: number) {}

  size(): number {
    return this.map.size;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): Promise<ProxyResult> | undefined {
    return this.map.get(key);
  }

  /**
   * Регистрирует новый promise или присоединяется к существующему.
   * @throws ActiveDedupFullError если ключ новый и Map уже заполнен.
   */
  registerOrJoin(
    key: string,
    factory: () => Promise<ProxyResult>,
  ): Promise<ProxyResult> {
    const existing = this.map.get(key);
    if (existing) return existing;

    if (this.map.size >= this.cap) {
      throw new ActiveDedupFullError(this.map.size, this.cap);
    }

    const promise = factory().finally(() => {
      this.map.delete(key);
    });
    this.map.set(key, promise);
    return promise;
  }
}

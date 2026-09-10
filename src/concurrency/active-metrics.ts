import type { ActiveSource, ActiveRequestSnapshot } from '../watchdog/ticker.js';

/**
 * Отмена живого запроса самим прокси (например, ключ отозван): код и текст, который можно
 * показать клиенту. Отличает такую отмену от обрыва клиентом и от таймаутов.
 */
export class ProxyAbort extends Error {
  override readonly name = 'ProxyAbort';
  constructor(
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

export interface LiveRequestMeta {
  /** Request-id журнала: может прийти от клиента, поэтому ключом реестра не служит. */
  requestId?: string;
  /** Агентский токен — чтобы оборвать его запросы при отзыве. */
  tokenId?: number;
}

interface LiveRequest extends LiveRequestMeta {
  clientId: string;
  admitted: boolean;
  startedAt: number;
  deadlineAt: number;
  abort: AbortController;
}

/**
 * Реестр живых запросов одного контура: для watchdog'а, для сверки admission-счётчиков
 * (concurrency/reconcile.ts) и для остановки сервиса (abortAll).
 *
 * Ключ — внутренний id, который выдаёт прокси (liveId). X-Request-Id клиента ключом быть не
 * может: параллельные запросы с одинаковым заголовком слились бы в одну запись, и сверка
 * слотов приняла бы живые запросы за утечку.
 */
export class ActiveMetrics implements ActiveSource {
  private readonly active = new Map<string, LiveRequest>();

  /**
   * `admitted` — прошёл ли этот конкретный request fairness.tryAdmit (а не dedup-join,
   * который делит промис с уже admitted-запросом и слот не занимает). Различие важно для
   * countAdmittedByClient()/countAdmittedTotal() — join-запросы не должны туда попадать.
   */
  register(
    liveId: string,
    clientId: string,
    admitted: boolean,
    deadlineAt: number,
    abort: AbortController,
    meta: LiveRequestMeta = {},
  ): void {
    this.active.set(liveId, { ...meta, clientId, admitted, startedAt: Date.now(), deadlineAt, abort });
  }

  unregister(liveId: string): void {
    this.active.delete(liveId);
  }

  size(): number {
    return this.active.size;
  }

  snapshot(): ActiveRequestSnapshot[] {
    return [...this.active.entries()].map(([liveId, v]) => ({
      requestId: liveId,
      label: v.requestId ?? liveId,
      startedAt: v.startedAt,
      deadlineAt: v.deadlineAt,
    }));
  }

  abort(liveId: string): void {
    this.active.get(liveId)?.abort.abort();
  }

  /** Остановка сервиса: оборвать все живые запросы, чтобы они дописали журнал и ответили. */
  abortAll(): number {
    let n = 0;
    for (const v of this.active.values()) {
      v.abort.abort();
      n += 1;
    }
    return n;
  }

  /** Оборвать запросы, подходящие под условие (например, отозванного ключа). */
  abortWhere(pred: (r: Readonly<LiveRequestMeta & { clientId: string }>) => boolean, reason?: unknown): number {
    let n = 0;
    for (const v of this.active.values()) {
      if (v.abort.signal.aborted || !pred(v)) continue;
      v.abort.abort(reason);
      n += 1;
    }
    return n;
  }

  /** Живые admitted-запросы (реально занимают fairness-слот) по clientId — эталон для reconcile(). */
  countAdmittedByClient(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const v of this.active.values()) {
      if (!v.admitted) continue;
      counts.set(v.clientId, (counts.get(v.clientId) ?? 0) + 1);
    }
    return counts;
  }

  /** Суммарно admitted-запросов (эталон для глобального счётчика fairness). */
  countAdmittedTotal(): number {
    let n = 0;
    for (const v of this.active.values()) if (v.admitted) n++;
    return n;
  }
}

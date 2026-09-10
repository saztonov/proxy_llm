import type { ActiveSource, ActiveRequestSnapshot } from '../watchdog/ticker.js';

/**
 * Реестр живых запросов одного контура: для watchdog'а, для сверки admission-счётчиков
 * (concurrency/reconcile.ts) и для остановки сервиса (abortAll).
 */
export class ActiveMetrics implements ActiveSource {
  private readonly active = new Map<
    string,
    { clientId: string; admitted: boolean; startedAt: number; deadlineAt: number; abort: AbortController }
  >();

  /**
   * `admitted` — прошёл ли этот конкретный request fairness.tryAdmit (а не dedup-join,
   * который делит промис с уже admitted-запросом и слот не занимает). Различие важно для
   * countAdmittedByClient()/countAdmittedTotal() — join-запросы не должны туда попадать.
   */
  register(requestId: string, clientId: string, admitted: boolean, deadlineAt: number, abort: AbortController): void {
    this.active.set(requestId, { clientId, admitted, startedAt: Date.now(), deadlineAt, abort });
  }

  unregister(requestId: string): void {
    this.active.delete(requestId);
  }

  size(): number {
    return this.active.size;
  }

  snapshot(): ActiveRequestSnapshot[] {
    return [...this.active.entries()].map(([requestId, v]) => ({
      requestId,
      startedAt: v.startedAt,
      deadlineAt: v.deadlineAt,
    }));
  }

  abort(requestId: string): void {
    this.active.get(requestId)?.abort.abort();
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

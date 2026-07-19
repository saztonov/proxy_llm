import PQueue from 'p-queue';
import type { ClientConfig, ClientRegistry } from '../clients/registry.js';

export type AdmitResult = 'ok' | 'client_full' | 'global_full' | 'dedup_full';

/** Расхождение, найденное и исправленное reconcile() — для логирования вызывающей стороной. */
export interface DriftCorrection {
  /** clientId клиента или 'global' для общего счётчика. */
  scope: string;
  trackedActive: number;
  actualActive: number;
}

interface ClientSlot {
  queue: PQueue;
  /** admitted-но-ещё-не-завершённые запросы клиента (running + pending). */
  active: number;
  maxConcurrency: number;
  maxPending: number;
}

/**
 * Честное распределение конкурентности между арендаторами.
 *
 * Исполнение: clientQueue.add(() => globalQueue.add(() => fn())). Клиент занимает в общей
 * FIFO не больше своего maxConcurrency мест → не может вытеснить остальных.
 *
 * Admission (tryAdmit/release) — синхронные счётчики, инкремент без await между проверкой и
 * ++ (закрывает race между onRequest-хуком и постановкой в очередь). release идемпотентен по
 * флагу на стороне вызывающего (proxyContext.released).
 */
export class FairnessManager {
  readonly globalQueue: PQueue;
  private readonly slots = new Map<string, ClientSlot>();
  private globalActive = 0;

  constructor(
    registry: ClientRegistry,
    private readonly globalConcurrency: number,
    private readonly globalMaxPending: number,
    private readonly dedupSize: () => number,
    private readonly maxActiveDedupKeys: number,
  ) {
    this.globalQueue = new PQueue({ concurrency: globalConcurrency });
    for (const c of registry.clients()) this.ensureSlot(c);
  }

  /** Предсоздаёт слот клиента (клиенты статичны — из реестра, без динамических утечек). */
  private ensureSlot(c: ClientConfig): ClientSlot {
    let slot = this.slots.get(c.clientId);
    if (!slot) {
      slot = {
        queue: new PQueue({ concurrency: c.maxConcurrency }),
        active: 0,
        maxConcurrency: c.maxConcurrency,
        maxPending: c.maxPending,
      };
      this.slots.set(c.clientId, slot);
    }
    return slot;
  }

  /**
   * Атомарная (в пределах тика event-loop) проверка+резервирование слота.
   * Вызывать СИНХРОННО, без await до/после в admission-хуке.
   */
  tryAdmit(client: ClientConfig): AdmitResult {
    const slot = this.ensureSlot(client);
    if (slot.active >= slot.maxConcurrency + slot.maxPending) return 'client_full';
    if (this.globalActive >= this.globalMaxPending) return 'global_full';
    if (this.dedupSize() >= this.maxActiveDedupKeys) return 'dedup_full';
    slot.active++;
    this.globalActive++;
    return 'ok';
  }

  /** Освобождает зарезервированный слот. Идемпотентность — на стороне вызывающего. */
  release(clientId: string): void {
    const slot = this.slots.get(clientId);
    if (slot) slot.active = Math.max(0, slot.active - 1);
    this.globalActive = Math.max(0, this.globalActive - 1);
  }

  /** Пер-клиентская очередь для постановки задачи. */
  queueFor(clientId: string): PQueue {
    return this.slots.get(clientId)?.queue ?? this.globalQueue;
  }

  /**
   * Сверяет tracked-счётчики (active per client + globalActive) с фактическим числом
   * admitted-запросов (эталон — ActiveMetrics.countAdmittedByClient()/countAdmittedTotal(),
   * которые обновляются в finally-блоке обработчика запроса и не подвержены утечке из-за
   * пропущенных Fastify-хуков onResponse/onRequestAbort).
   *
   * Зачем: release() слота полагается на то, что onResponse либо onRequestAbort гарантированно
   * сработает ровно один раз для каждого admitted-запроса. Если по какой-то причине (редкий
   * edge-case на стороне соединения клиент↔nginx↔Node) не сработал ни один из хуков — slot.active
   * навечно застревает на maxConcurrency+maxPending, и клиент получает queue_full независимо от
   * реальной нагрузки, до ручного restart (см. docs/runbook.md, инцидент estimat 2026-07-17).
   * reconcile() — самовосстановление на случай именно такой утечки, вызывать периодически.
   */
  reconcile(actualByClient: Map<string, number>, actualGlobal: number): DriftCorrection[] {
    const corrections: DriftCorrection[] = [];
    for (const [clientId, slot] of this.slots) {
      const actual = actualByClient.get(clientId) ?? 0;
      if (slot.active !== actual) {
        corrections.push({ scope: clientId, trackedActive: slot.active, actualActive: actual });
        slot.active = actual;
      }
    }
    if (this.globalActive !== actualGlobal) {
      corrections.push({ scope: 'global', trackedActive: this.globalActive, actualActive: actualGlobal });
      this.globalActive = actualGlobal;
    }
    return corrections;
  }

  /** Метрики для дашборда/дебага. */
  snapshot(): { globalActive: number; globalConcurrency: number; perClient: Array<{ clientId: string; active: number; maxConcurrency: number; maxPending: number }> } {
    return {
      globalActive: this.globalActive,
      globalConcurrency: this.globalConcurrency,
      perClient: [...this.slots.entries()].map(([clientId, s]) => ({
        clientId,
        active: s.active,
        maxConcurrency: s.maxConcurrency,
        maxPending: s.maxPending,
      })),
    };
  }
}

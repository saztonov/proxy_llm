import { describe, expect, it, vi } from 'vitest';
import { FairnessManager } from '../src/concurrency/fairness.js';
import { startFairnessReconciler } from '../src/concurrency/reconcile.js';
import { ActiveMetrics } from '../src/routes/chat-completions.js';
import type { ClientConfig, ClientRegistry } from '../src/clients/registry.js';
import type { Logger } from '../src/utils/logger.js';

function fakeRegistry(clients: ClientConfig[]): ClientRegistry {
  return { clients: () => clients } as ClientRegistry;
}

function makeClient(overrides: Partial<ClientConfig> = {}): ClientConfig {
  return {
    clientId: 'estimat',
    defaultModel: 'google/gemini-2.5-flash',
    allowedModels: [],
    fallbackModels: [],
    maxConcurrency: 1,
    maxPending: 2,
    source: 'estimat',
    ...overrides,
  };
}

describe('FairnessManager.reconcile — самовосстановление после утечки admission-слота', () => {
  it('регрессия инцидента estimat 2026-07-17: залипший слот освобождается reconcile(), клиент снова admitted', () => {
    const client = makeClient();
    const fairness = new FairnessManager(fakeRegistry([client]), 3, 6, () => 0, 1000);

    // Заполняем слот клиента до предела (maxConcurrency + maxPending = 3), как во время шторма.
    expect(fairness.tryAdmit(client)).toBe('ok');
    expect(fairness.tryAdmit(client)).toBe('ok');
    expect(fairness.tryAdmit(client)).toBe('ok');

    // Симулируем утечку: release() не был вызван ни для одного из трёх (баг в hook'ах Fastify).
    expect(fairness.tryAdmit(client)).toBe('client_full');

    // Без reconcile — клиент навечно застрял, как это было с estimat 2 дня.
    expect(fairness.tryAdmit(client)).toBe('client_full');

    // ActiveMetrics (эталон) считает 0 admitted-запросов клиента: все давно завершились
    // (finally-блок отработал), просто release() к fairness не долетел.
    const corrections = fairness.reconcile(new Map(), 0);

    expect(corrections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'estimat', trackedActive: 3, actualActive: 0 }),
        expect.objectContaining({ scope: 'global', trackedActive: 3, actualActive: 0 }),
      ]),
    );

    // Слот освобождён самовосстановлением — клиент снова обслуживается без restart процесса.
    expect(fairness.tryAdmit(client)).toBe('ok');
  });

  it('без расхождения reconcile() не возвращает корректировок', () => {
    const client = makeClient();
    const fairness = new FairnessManager(fakeRegistry([client]), 3, 6, () => 0, 1000);

    expect(fairness.tryAdmit(client)).toBe('ok');

    const corrections = fairness.reconcile(new Map([[client.clientId, 1]]), 1);
    expect(corrections).toEqual([]);
  });

  it('reconcile корректирует только расходящегося клиента, остальные не трогает', () => {
    const a = makeClient({ clientId: 'a' });
    const b = makeClient({ clientId: 'b' });
    const fairness = new FairnessManager(fakeRegistry([a, b]), 10, 10, () => 0, 1000);

    expect(fairness.tryAdmit(a)).toBe('ok');
    expect(fairness.tryAdmit(b)).toBe('ok');

    // Только у 'a' расхождение (утечка), у 'b' всё сходится. Глобальный счётчик расходится
    // как следствие (2 tracked vs 1 actual), исправляется тем же вызовом.
    const corrections = fairness.reconcile(new Map([['b', 1]]), 1);
    expect(corrections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'a', trackedActive: 1, actualActive: 0 }),
        expect.objectContaining({ scope: 'global', trackedActive: 2, actualActive: 1 }),
      ]),
    );
    expect(corrections).toHaveLength(2);

    expect(fairness.tryAdmit(a)).toBe('ok'); // 'a' восстановлен
  });
});

describe('startFairnessReconciler — корректирует только устойчивое превышение', () => {
  const silentLogger = {
    warn: () => {},
    debug: () => {},
    info: () => {},
    error: () => {},
  } as unknown as Logger;

  /** Прогоняет N тиков, возвращая записанные warn-события. */
  function runTicks(
    fairness: FairnessManager,
    metrics: ActiveMetrics,
    ticks: number,
    sustainTicks = 4,
  ): Array<Record<string, unknown>> {
    const warns: Array<Record<string, unknown>> = [];
    const logger = {
      ...silentLogger,
      warn: (obj: Record<string, unknown>) => void warns.push(obj),
    } as unknown as Logger;

    vi.useFakeTimers();
    const stop = startFairnessReconciler(fairness, metrics, logger, 30_000, sustainTicks);
    try {
      for (let i = 0; i < ticks; i++) vi.advanceTimersByTime(30_000);
    } finally {
      stop();
      vi.useRealTimers();
    }
    return warns;
  }

  it('НЕ трогает слот запроса, который в этот момент между admission и регистрацией', () => {
    // Инцидент 20-21.07.2026: слот выдан в onRequest, тело на 483 КБ ещё парсится, в
    // ActiveMetrics запрос не попал. Мгновенная сверка обнуляла его слот, снимая лимит.
    const client = makeClient({ clientId: 'matcheck' });
    const fairness = new FairnessManager(fakeRegistry([client]), 3, 6, () => 0, 1000);
    const metrics = new ActiveMetrics();

    expect(fairness.tryAdmit(client)).toBe('ok');

    // Один тик застаёт запрос в окне парсинга, дальше он регистрируется как положено.
    const warns: Array<Record<string, unknown>> = [];
    const logger = {
      ...silentLogger,
      warn: (o: Record<string, unknown>) => void warns.push(o),
    } as unknown as Logger;

    vi.useFakeTimers();
    const stop = startFairnessReconciler(fairness, metrics, logger, 30_000, 4);
    try {
      vi.advanceTimersByTime(30_000); // тик 1: tracked=1, actual=0 — ложное расхождение
      metrics.register('req-1', 'matcheck', true, Date.now() + 60_000, new AbortController());
      for (let i = 0; i < 5; i++) vi.advanceTimersByTime(30_000); // тики 2..6: всё сходится
    } finally {
      stop();
      vi.useRealTimers();
    }

    expect(warns).toEqual([]);
    // Слот живого запроса на месте: лимит конкурентности не снят.
    expect(fairness.snapshot().perClient[0]?.active).toBe(1);
  });

  it('исправляет утечку, которая держится всё окно наблюдения', () => {
    const client = makeClient({ clientId: 'estimat' });
    const fairness = new FairnessManager(fakeRegistry([client]), 3, 6, () => 0, 1000);
    const metrics = new ActiveMetrics(); // эталон пуст: запросы давно завершились

    fairness.tryAdmit(client);
    fairness.tryAdmit(client);
    fairness.tryAdmit(client);
    expect(fairness.tryAdmit(client)).toBe('client_full'); // клиент заблокирован

    const warns = runTicks(fairness, metrics, 4);

    expect(warns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'estimat', leakedSlots: 3 }),
        expect.objectContaining({ scope: 'global', leakedSlots: 3 }),
      ]),
    );
    expect(fairness.tryAdmit(client)).toBe('ok'); // восстановлен без restart
  });

  it('раньше окна не корректирует — три тика подряд ещё не приговор', () => {
    const client = makeClient({ clientId: 'estimat' });
    const fairness = new FairnessManager(fakeRegistry([client]), 3, 6, () => 0, 1000);
    fairness.tryAdmit(client);

    expect(runTicks(fairness, new ActiveMetrics(), 3)).toEqual([]);
    expect(fairness.snapshot().perClient[0]?.active).toBe(1);
  });

  it('под нагрузкой вычитает только залипшую часть, живые запросы не трогает', () => {
    // 1 слот утёк навсегда + 1 запрос реально в работе. Сверка обязана снять ровно один.
    const client = makeClient({ clientId: 'matcheck', maxConcurrency: 2, maxPending: 4 });
    const fairness = new FairnessManager(fakeRegistry([client]), 10, 10, () => 0, 1000);
    const metrics = new ActiveMetrics();

    fairness.tryAdmit(client); // утёкший
    fairness.tryAdmit(client); // живой
    metrics.register('req-live', 'matcheck', true, Date.now() + 60_000, new AbortController());

    const warns = runTicks(fairness, metrics, 4);

    expect(warns).toEqual(
      expect.arrayContaining([expect.objectContaining({ scope: 'matcheck', leakedSlots: 1 })]),
    );
    // Остался ровно слот живого запроса.
    expect(fairness.snapshot().perClient[0]?.active).toBe(1);
  });
});

describe('ActiveMetrics — admitted vs dedup-join не путаются в счётчиках-эталонах', () => {
  it('countAdmittedByClient/countAdmittedTotal учитывают только admitted=true', () => {
    const metrics = new ActiveMetrics();
    metrics.register('req-primary', 'estimat', true, Date.now() + 1000, new AbortController());
    // dedup-join: тот же clientId, но не проходил tryAdmit — слот fairness не занимает.
    metrics.register('req-joiner', 'estimat', false, Date.now() + 1000, new AbortController());
    metrics.register('req-other-client', 'matcheck', true, Date.now() + 1000, new AbortController());

    expect(metrics.size()).toBe(3); // watchdog должен видеть все живые запросы, включая join
    expect(metrics.countAdmittedByClient()).toEqual(
      new Map([
        ['estimat', 1],
        ['matcheck', 1],
      ]),
    );
    expect(metrics.countAdmittedTotal()).toBe(2);

    metrics.unregister('req-primary');
    expect(metrics.countAdmittedByClient().get('estimat')).toBeUndefined();
    expect(metrics.countAdmittedTotal()).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { FairnessManager } from '../src/concurrency/fairness.js';
import { ActiveMetrics } from '../src/routes/chat-completions.js';
import type { ClientConfig, ClientRegistry } from '../src/clients/registry.js';

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

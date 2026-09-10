import { describe, expect, it } from 'vitest';
import { FairnessManager, type FairnessTenant } from '../src/concurrency/fairness.js';

const t = (clientId: string, maxConcurrency = 1, maxPending = 1): FairnessTenant => ({ clientId, maxConcurrency, maxPending });

describe('FairnessManager.syncClients', () => {
  it('creates slots for new tenants and applies changed limits on the fly', () => {
    const f = new FairnessManager({ clients: () => [t('a')] }, 10, 100, () => 0, 100);
    f.syncClients([t('a', 3, 2), t('b')]);
    const snap = Object.fromEntries(f.snapshot().perClient.map((p) => [p.clientId, p]));
    expect(snap['a']).toMatchObject({ maxConcurrency: 3, maxPending: 2 });
    expect(snap['b']).toMatchObject({ maxConcurrency: 1 });
    expect(f.queueFor('a').concurrency).toBe(3);
  });

  it('tryAdmit with a fresher config updates the slot limits too', () => {
    const f = new FairnessManager({ clients: () => [t('a', 1, 1)] }, 10, 100, () => 0, 100);
    expect(f.tryAdmit(t('a', 1, 1))).toBe('ok');
    expect(f.tryAdmit(t('a', 1, 1))).toBe('ok');
    expect(f.tryAdmit(t('a', 1, 1))).toBe('client_full');
    // Лимит подняли в админке — следующий запрос проходит без рестарта.
    expect(f.tryAdmit(t('a', 2, 2))).toBe('ok');
    expect(f.queueFor('a').concurrency).toBe(2);
  });

  it('removed idle tenant is dropped; busy one is retired until its last release', () => {
    const f = new FairnessManager({ clients: () => [t('idle'), t('busy')] }, 10, 100, () => 0, 100);
    expect(f.tryAdmit(t('busy'))).toBe('ok');
    f.syncClients([]);
    const ids = () => f.snapshot().perClient.map((p) => p.clientId);
    expect(ids()).toEqual(['busy']);
    f.release('busy');
    expect(ids()).toEqual([]);
    expect(f.snapshot().globalActive).toBe(0);
  });

  it('a retired tenant that comes back keeps its slot', () => {
    const f = new FairnessManager({ clients: () => [t('x')] }, 10, 100, () => 0, 100);
    expect(f.tryAdmit(t('x'))).toBe('ok');
    f.syncClients([]);
    f.syncClients([t('x')]);
    f.release('x');
    expect(f.snapshot().perClient.map((p) => p.clientId)).toEqual(['x']);
  });
});

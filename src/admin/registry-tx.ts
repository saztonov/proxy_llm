import type Database from 'better-sqlite3';
import type { SiteRegistry } from '../clients/site-registry.js';
import type { AgentRegistry } from '../clients/agent-registry.js';

export interface Registries {
  site: SiteRegistry;
  agent: AgentRegistry;
}

/**
 * prepare-then-publish: изменение, аудит и сборка новых снапшотов обоих реестров — в одной
 * транзакции. Снапшоты собираются внутри неё (видят незакоммиченные изменения) и падают до
 * commit, если данные не собираются; тогда откатывается всё, включая аудит, а в памяти
 * остаются прежние снапшоты. После commit снапшоты подменяются атомарно — отзыв токена
 * вступает в силу со следующим запросом.
 */
export function applyChange<T>(db: Database.Database, regs: Registries, fn: () => T): T {
  let site: ReturnType<SiteRegistry['buildSnapshot']> | undefined;
  let agent: ReturnType<AgentRegistry['buildSnapshot']> | undefined;
  const result = db.transaction(() => {
    const r = fn();
    site = regs.site.buildSnapshot();
    agent = regs.agent.buildSnapshot();
    return r;
  })();
  regs.site.publish(site!);
  regs.agent.publish(agent!);
  return result;
}

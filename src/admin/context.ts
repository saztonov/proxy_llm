import type Database from 'better-sqlite3';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { Repos } from '../storage/repos.js';
import type { SecretBox } from '../storage/secret-box.js';
import type { SiteRegistry } from '../clients/site-registry.js';
import type { AgentRegistry } from '../clients/agent-registry.js';
import type { FairnessManager } from '../concurrency/fairness.js';
import type { ActiveMetrics } from '../concurrency/active-metrics.js';
import type { AlertEngine } from '../alerts/rules.js';

/** Всё, что админке нужно от приложения. Собирается в app.ts. */
export interface AdminDeps {
  config: Config;
  logger: Logger;
  db: Database.Database;
  repos: Repos;
  secrets: SecretBox;
  siteRegistry: SiteRegistry;
  agentRegistry: AgentRegistry;
  fairness: FairnessManager;
  agentFairness: FairnessManager;
  activeMetrics: ActiveMetrics;
  agentActiveMetrics: ActiveMetrics;
  alerts: AlertEngine;
}

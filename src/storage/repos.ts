import type Database from 'better-sqlite3';
import { RequestsRepo } from './requests-repo.js';
import { BillingRepo } from './billing-repo.js';
import { SiteClientsRepo } from './site-clients-repo.js';
import { SiteTokensRepo } from './site-tokens-repo.js';
import { DirectoryRepo } from './directory-repo.js';
import { ProvidersRepo } from './providers-repo.js';
import { AgentTokensRepo } from './agent-tokens-repo.js';
import { SettingsRepo } from './settings-repo.js';
import { AdminUsersRepo } from './admin-users-repo.js';
import { AdminSessionsRepo } from './admin-sessions-repo.js';
import { AdminAuditRepo } from './admin-audit-repo.js';

/** Все репозитории поверх одного соединения SQLite. */
export interface Repos {
  requests: RequestsRepo;
  billing: BillingRepo;
  siteClients: SiteClientsRepo;
  siteTokens: SiteTokensRepo;
  directory: DirectoryRepo;
  providers: ProvidersRepo;
  agentTokens: AgentTokensRepo;
  settings: SettingsRepo;
  adminUsers: AdminUsersRepo;
  adminSessions: AdminSessionsRepo;
  audit: AdminAuditRepo;
}

export function createRepos(db: Database.Database): Repos {
  return {
    requests: new RequestsRepo(db),
    billing: new BillingRepo(db),
    siteClients: new SiteClientsRepo(db),
    siteTokens: new SiteTokensRepo(db),
    directory: new DirectoryRepo(db),
    providers: new ProvidersRepo(db),
    agentTokens: new AgentTokensRepo(db),
    settings: new SettingsRepo(db),
    adminUsers: new AdminUsersRepo(db),
    adminSessions: new AdminSessionsRepo(db),
    audit: new AdminAuditRepo(db),
  };
}

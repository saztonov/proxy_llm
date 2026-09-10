import type { AdminDeps } from './context.js';
import type { SessionService } from './auth/session-service.js';
import type { AdminKeys } from './auth/keys.js';
import type { AuthHooks } from './auth/hooks.js';
import type { AuditLog } from './audit.js';
import type { AdminRenderer } from './render.js';

/** Контекст маршрутов админки: зависимости приложения + сервисы авторизации и рендера. */
export interface AdminCtx extends AdminDeps {
  sessions: SessionService;
  keys: AdminKeys;
  hooks: AuthHooks;
  audit: AuditLog;
  renderer: AdminRenderer;
  /** prepare-then-publish поверх обоих реестров (см. registry-tx.ts). */
  change<T>(fn: () => T): T;
}

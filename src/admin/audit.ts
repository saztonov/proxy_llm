import type { FastifyRequest } from 'fastify';
import type { AdminAuditRepo } from '../storage/admin-audit-repo.js';
import type { AdminUsersRepo } from '../storage/admin-users-repo.js';
import type { Logger } from '../utils/logger.js';
import { removeSecrets } from '../utils/sanitize.js';

/**
 * Разрешённые поля details. Всё остальное отбрасывается, поэтому ключи, токены и пароли
 * в журнал аудита не попадают по построению, даже если их передадут по ошибке.
 */
const DETAIL_KEYS: ReadonlySet<string> = new Set([
  'label', 'prefix', 'tokenId', 'clientId', 'fields', 'enabled', 'model', 'providerId', 'principalType',
  'departmentId', 'employeeId', 'expiresAt', 'name', 'slug', 'login', 'baseUrl', 'usageMode',
  'apiKeyChanged', 'extraHeadersChanged', 'ok', 'httpStatus', 'reason', 'failures', 'allowedCidrs',
]);

type Scalar = string | number | boolean | null;

function clean(v: unknown): Scalar | Scalar[] | undefined {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return removeSecrets(v).slice(0, 200);
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clean(x)).filter((x): x is Scalar => x !== undefined && !Array.isArray(x));
  return undefined;
}

export function pickDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!details) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (!DETAIL_KEYS.has(k)) continue;
    const c = clean(v);
    if (c !== undefined) out[k] = c;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export interface AuditActor {
  adminId: number | null;
  ip: string | null;
}

export function actorOf(req: FastifyRequest): AuditActor {
  return { adminId: req.adminSession?.adminId ?? null, ip: req.ip };
}

/** Журнал действий: строка в admin_audit_log (внутри транзакции изменения) + строка в pino. */
export class AuditLog {
  constructor(
    private readonly repo: AdminAuditRepo,
    private readonly users: AdminUsersRepo,
    private readonly logger: Logger,
  ) {}

  record(actor: AuditActor, action: string, entityType: string, entityId: string | number | null, details?: Record<string, unknown>): void {
    const picked = pickDetails(details);
    const login = actor.adminId !== null ? (this.users.get(actor.adminId)?.login ?? null) : null;
    this.repo.insert({
      ts: Date.now(),
      admin_id: actor.adminId,
      admin_login: login,
      ip: actor.ip,
      action,
      entity_type: entityType,
      entity_id: entityId === null ? null : String(entityId),
      details_json: picked ? JSON.stringify(picked) : null,
    });
    this.logger.info({ audit: true, action, entityType, entityId, adminId: actor.adminId, ip: actor.ip }, 'admin audit');
  }
}

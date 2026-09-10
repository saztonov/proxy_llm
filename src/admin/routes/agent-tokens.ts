import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AdminCtx } from '../ctx.js';
import { parseOr400, sendError, idParam, modelSlug } from '../validation.js';
import { actorOf } from '../audit.js';
import { generateToken } from '../../clients/tokens.js';
import { validateCidr } from '../../utils/cidr.js';
import type { AgentTokenListRow, AgentTokenPatch } from '../../storage/agent-tokens-repo.js';
import type { ProviderRow } from '../../storage/providers-repo.js';
import type { AgentDefaults } from '../../storage/settings-repo.js';

const cidrs = z.array(z.string().trim().min(1).max(64)).max(50);
const createBody = z.object({
  principalType: z.enum(['department', 'employee']),
  departmentId: z.number().int().positive().optional(),
  employeeId: z.number().int().positive().optional(),
  // null — «метка очищена» (так шлёт интерфейс), хранится как пустая строка.
  label: z.string().trim().max(100).nullable().optional(),
  providerId: z.number().int().positive().nullable().optional(),
  model: modelSlug.nullable().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  allowedCidrs: cidrs.optional(),
}).strict();
const patchBody = z.object({
  label: z.string().trim().max(100).nullable().optional(),
  providerId: z.number().int().positive().nullable().optional(),
  model: modelSlug.nullable().optional(),
  expiresAt: z.number().int().positive().nullable().optional(),
  allowedCidrs: cidrs.nullable().optional(),
  enabled: z.boolean().optional(),
}).strict();
const listQuery = z.object({
  departmentId: z.coerce.number().int().positive().optional(),
  employeeId: z.coerce.number().int().positive().optional(),
  includeRevoked: z.enum(['0', '1', 'true', 'false']).optional(),
});

type Issue = { path: string; message: string };

export function agentBaseUrl(req: FastifyRequest): string {
  return `${req.protocol}://${req.host}/agent/v1`;
}

function effectiveOf(row: AgentTokenListRow, providers: Map<number, ProviderRow>, d: AgentDefaults) {
  if (row.provider_id !== null && row.model !== null) {
    const p = providers.get(row.provider_id);
    return p && p.enabled === 1 ? { providerName: p.name, model: row.model, origin: 'token' as const } : null;
  }
  if (d.providerId !== null && d.model) {
    const p = providers.get(d.providerId);
    return p && p.enabled === 1 ? { providerName: p.name, model: d.model, origin: 'global_default' as const } : null;
  }
  return null;
}

function parseCidrs(json: string | null): string[] | null {
  if (json === null) return null;
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

function tokenView(row: AgentTokenListRow, providers: Map<number, ProviderRow>, d: AgentDefaults) {
  return {
    id: row.id, prefix: row.token_prefix, label: row.label, principalType: row.principal_type,
    departmentId: row.eff_department_id, departmentName: row.department_name, employeeId: row.employee_id,
    employeeLogin: row.employee_login, employeeName: row.employee_name, providerId: row.provider_id,
    providerName: row.provider_name, model: row.model, effective: effectiveOf(row, providers, d),
    expiresAt: row.expires_at, allowedCidrs: parseCidrs(row.allowed_cidrs_json), enabled: row.enabled === 1,
    createdAt: row.created_at, revokedAt: row.revoked_at, lastUsedAt: row.last_used_at,
  };
}

/** Общие проверки выпуска и правки: пара провайдер+модель, провайдер жив, сети, срок. */
function checkTarget(ctx: AdminCtx, b: { providerId?: number | null | undefined; model?: string | null | undefined; allowedCidrs?: string[] | null | undefined; expiresAt?: number | null | undefined }): Issue[] {
  const issues: Issue[] = [];
  const hasP = b.providerId !== undefined && b.providerId !== null;
  const hasM = b.model !== undefined && b.model !== null;
  if (hasP !== hasM) issues.push({ path: 'model', message: 'providerId and model go together (or both empty for the global default)' });
  if (hasP) {
    const p = ctx.repos.providers.get(b.providerId!);
    if (!p) issues.push({ path: 'providerId', message: 'provider not found' });
    else if (p.enabled !== 1) issues.push({ path: 'providerId', message: 'provider is disabled' });
  }
  for (const c of b.allowedCidrs ?? []) {
    const err = validateCidr(c);
    if (err) issues.push({ path: 'allowedCidrs', message: err });
  }
  if (b.expiresAt !== undefined && b.expiresAt !== null && b.expiresAt <= Date.now()) {
    issues.push({ path: 'expiresAt', message: 'expiry must be in the future' });
  }
  return issues;
}

export async function registerAgentTokenRoutes(app: FastifyInstance, ctx: AdminCtx): Promise<void> {
  const repo = ctx.repos.agentTokens;
  const lookup = () => ({ providers: new Map(ctx.repos.providers.list().map((p) => [p.id, p])), defaults: ctx.repos.settings.agentDefaults() });
  const viewById = (id: number) => {
    const { providers, defaults } = lookup();
    const row = repo.list({ includeRevoked: true }).find((t) => t.id === id);
    return row ? tokenView(row, providers, defaults) : null;
  };

  app.get('/agent-tokens', async (req, reply) => {
    const q = parseOr400(listQuery, req.query, reply);
    if (!q) return;
    const { providers, defaults } = lookup();
    const rows = repo.list({
      ...(q.departmentId ? { departmentId: q.departmentId } : {}),
      ...(q.employeeId ? { employeeId: q.employeeId } : {}),
      includeRevoked: q.includeRevoked === '1' || q.includeRevoked === 'true',
    });
    reply.send({ tokens: rows.map((r) => tokenView(r, providers, defaults)), agentBaseUrl: agentBaseUrl(req) });
  });

  app.post('/agent-tokens', async (req, reply) => {
    const b = parseOr400(createBody, req.body, reply);
    if (!b) return;
    const issues = checkTarget(ctx, b);
    const isEmp = b.principalType === 'employee';
    const ownerId = isEmp ? b.employeeId : b.departmentId;
    const owner = ownerId === undefined ? null : isEmp ? ctx.repos.directory.getEmployee(ownerId) : ctx.repos.directory.getDepartment(ownerId);
    if (!owner) issues.push({ path: isEmp ? 'employeeId' : 'departmentId', message: 'owner not found' });
    if (issues.length) return sendError(reply, 400, 'invalid_request', 'validation failed', { issues });
    const t = generateToken('agent');
    const id = ctx.change(() => {
      const newId = repo.issue({
        token_sha256: t.sha256, token_prefix: t.prefix, label: b.label ?? '', principal_type: b.principalType,
        department_id: isEmp ? null : ownerId!, employee_id: isEmp ? ownerId! : null,
        provider_id: b.providerId ?? null, model: b.model ?? null,
        allowed_cidrs_json: b.allowedCidrs && b.allowedCidrs.length > 0 ? JSON.stringify(b.allowedCidrs) : null,
        expires_at: b.expiresAt ?? null,
      }, Date.now());
      ctx.audit.record(actorOf(req), 'agent_token.issue', 'agent_token', newId, {
        prefix: t.prefix, label: b.label ?? '', principalType: b.principalType,
        ...(isEmp ? { employeeId: ownerId } : { departmentId: ownerId }),
        providerId: b.providerId ?? null, model: b.model ?? null, expiresAt: b.expiresAt ?? null,
      });
      return newId;
    });
    reply.code(201).send({ token: viewById(id), plaintext: t.plaintext, agentBaseUrl: agentBaseUrl(req) });
  });

  app.patch('/agent-tokens/:id', async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const b = parseOr400(patchBody, req.body, reply);
    if (!b) return;
    const row = repo.get(p.id);
    if (!row) return sendError(reply, 404, 'not_found', 'token not found');
    if (row.revoked_at !== null) return sendError(reply, 409, 'revoked', 'token is revoked');
    const targetTouched = b.providerId !== undefined || b.model !== undefined;
    const issues = checkTarget(ctx, targetTouched ? { ...b, providerId: b.providerId ?? null, model: b.model ?? null } : { allowedCidrs: b.allowedCidrs, expiresAt: b.expiresAt });
    if (issues.length) return sendError(reply, 400, 'invalid_request', 'validation failed', { issues });
    const patch: AgentTokenPatch = {};
    if (b.label !== undefined) patch.label = b.label ?? '';
    if (targetTouched) {
      patch.provider_id = b.providerId ?? null;
      patch.model = b.model ?? null;
    }
    if (b.expiresAt !== undefined) patch.expires_at = b.expiresAt;
    if (b.allowedCidrs !== undefined) patch.allowed_cidrs_json = b.allowedCidrs && b.allowedCidrs.length > 0 ? JSON.stringify(b.allowedCidrs) : null;
    if (b.enabled !== undefined) patch.enabled = b.enabled ? 1 : 0;
    ctx.change(() => {
      repo.update(p.id, patch);
      ctx.audit.record(actorOf(req), 'agent_token.update', 'agent_token', p.id, {
        fields: Object.keys(b), prefix: row.token_prefix, ...(targetTouched ? { providerId: b.providerId ?? null, model: b.model ?? null } : {}),
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
      });
    });
    reply.send({ token: viewById(p.id) });
  });

  app.post('/agent-tokens/:id/revoke', async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const row = repo.get(p.id);
    if (!row) return sendError(reply, 404, 'not_found', 'token not found');
    ctx.change(() => {
      repo.revoke(p.id, Date.now());
      ctx.audit.record(actorOf(req), 'agent_token.revoke', 'agent_token', p.id, { prefix: row.token_prefix, label: row.label });
    });
    reply.send({ token: viewById(p.id) });
  });
}

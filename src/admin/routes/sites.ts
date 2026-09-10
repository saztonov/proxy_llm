import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminCtx } from '../ctx.js';
import { parseOr400, sendError, modelSlug, secretField } from '../validation.js';
import { actorOf } from '../audit.js';
import { resolveEntry } from '../../clients/registry.js';
import { rowToEntry } from '../../clients/site-registry.js';
import { generateToken } from '../../clients/tokens.js';
import { SecretBox } from '../../storage/secret-box.js';
import type { SiteClientPatch, SiteClientRow } from '../../storage/site-clients-repo.js';
import type { SiteTokenRow } from '../../storage/site-tokens-repo.js';

const allowedModels = z
  .array(z.union([modelSlug, z.literal('*')]))
  .max(100)
  .refine((a) => !a.includes('*') || a.length === 1, 'wildcard * must be the only entry');

/** null — наследовать env-дефолт, отсутствие поля — не менять. */
const policy = {
  defaultModel: modelSlug.nullable().optional(),
  allowedModels: allowedModels.nullable().optional(),
  fallbackModels: z.array(modelSlug).max(20).nullable().optional(),
  maxConcurrency: z.number().int().min(1).max(20).nullable().optional(),
  maxPending: z.number().int().min(1).max(1000).nullable().optional(),
  openrouterApiKey: secretField,
  source: z.string().trim().min(1).max(64).nullable().optional(),
};
const createBody = z
  .object({ clientId: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/, 'clientId: 2-64 chars of a-z 0-9 _ -'), ...policy })
  .strict();
const patchBody = z.object({ ...policy, enabled: z.boolean().optional() }).strict();
const tokenBody = z.object({ label: z.string().trim().max(100).optional() }).strict();
const clientParam = z.object({ clientId: z.string().min(1).max(64) });
const tokenParam = z.object({ clientId: z.string().min(1).max(64), id: z.coerce.number().int().positive() });

type PolicyInput = Omit<z.infer<typeof patchBody>, 'enabled'> & { enabled?: boolean };

function parseList(json: string | null): string[] | null {
  if (json === null) return null;
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

function toPatch(b: PolicyInput, secrets: SecretBox): SiteClientPatch {
  const p: SiteClientPatch = {};
  if (b.defaultModel !== undefined) p.default_model = b.defaultModel;
  if (b.allowedModels !== undefined) p.allowed_models_json = b.allowedModels === null ? null : JSON.stringify(b.allowedModels);
  if (b.fallbackModels !== undefined) p.fallback_models_json = b.fallbackModels === null ? null : JSON.stringify(b.fallbackModels);
  if (b.maxConcurrency !== undefined) p.max_concurrency = b.maxConcurrency;
  if (b.maxPending !== undefined) p.max_pending = b.maxPending;
  if (b.source !== undefined) p.source = b.source;
  if (b.openrouterApiKey !== undefined) {
    p.openrouter_api_key_enc = b.openrouterApiKey === null ? null : secrets.seal(b.openrouterApiKey);
    p.openrouter_api_key_fp = b.openrouterApiKey === null ? null : SecretBox.fingerprint(b.openrouterApiKey);
  }
  if (b.enabled !== undefined) p.enabled = b.enabled ? 1 : 0;
  return p;
}

/** Что изменилось — без значений секретов (для аудита). */
function changes(b: Record<string, unknown>): Record<string, unknown> {
  return {
    fields: Object.keys(b).filter((k) => k !== 'openrouterApiKey' && b[k] !== undefined),
    apiKeyChanged: b.openrouterApiKey !== undefined,
    ...(typeof b.enabled === 'boolean' ? { enabled: b.enabled } : {}),
  };
}

export function tokenView(t: SiteTokenRow) {
  return {
    id: t.id,
    prefix: t.token_prefix,
    hashPrefix: t.token_sha256.slice(0, 8),
    label: t.label,
    createdAt: t.created_at,
    revokedAt: t.revoked_at,
    lastUsedAt: t.last_used_at,
  };
}

function siteView(ctx: AdminCtx, row: SiteClientRow) {
  let effective = null;
  try {
    const e = resolveEntry(rowToEntry(row, ctx.secrets), ctx.config);
    effective = { defaultModel: e.defaultModel, allowedModels: e.allowedModels, fallbackModels: e.fallbackModels, maxConcurrency: e.maxConcurrency, maxPending: e.maxPending };
  } catch {
    // Политика не собирается (битый JSON, чужой ключ шифрования) — показываем как есть.
  }
  const live = ctx.fairness.snapshot().perClient.find((p) => p.clientId === row.client_id);
  return {
    clientId: row.client_id,
    enabled: row.enabled === 1,
    defaultModel: row.default_model,
    allowedModels: parseList(row.allowed_models_json),
    fallbackModels: parseList(row.fallback_models_json),
    maxConcurrency: row.max_concurrency,
    maxPending: row.max_pending,
    source: row.source,
    hasOpenrouterApiKey: row.openrouter_api_key_enc !== null,
    openrouterApiKeyFp: row.openrouter_api_key_fp,
    importedFrom: row.imported_from,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    effective,
    live: live ? { active: live.active, maxConcurrency: live.maxConcurrency, maxPending: live.maxPending } : null,
    tokens: ctx.repos.siteTokens.listByClient(row.client_id).map(tokenView),
  };
}

export async function registerSiteRoutes(app: FastifyInstance, ctx: AdminCtx): Promise<void> {
  const { repos } = ctx;

  app.get('/sites', async (_req, reply) => {
    const c = ctx.config;
    reply.send({
      defaults: {
        defaultModel: c.OPENROUTER_MODEL,
        allowedModels: c.CLIENT_DEFAULT_ALLOWED_MODELS,
        fallbackModels: c.OPENROUTER_FALLBACK_MODELS,
        maxConcurrency: c.CLIENT_DEFAULT_MAX_CONCURRENCY,
        maxPending: c.CLIENT_DEFAULT_MAX_PENDING,
      },
      sites: repos.siteClients.list().map((r) => siteView(ctx, r)),
    });
  });

  app.post('/sites', async (req, reply) => {
    const b = parseOr400(createBody, req.body, reply);
    if (!b) return;
    const { clientId, ...rest } = b;
    ctx.change(() => {
      repos.siteClients.create({
        client_id: clientId, default_model: null, allowed_models_json: null, fallback_models_json: null,
        max_concurrency: null, max_pending: null, openrouter_api_key_enc: null, openrouter_api_key_fp: null,
        source: null, enabled: 1, imported_from: null, ...toPatch(rest, ctx.secrets),
      }, Date.now());
      ctx.audit.record(actorOf(req), 'site.create', 'site', clientId, changes(rest));
    });
    reply.code(201).send({ site: siteView(ctx, repos.siteClients.get(clientId)!) });
  });

  app.patch('/sites/:clientId', async (req, reply) => {
    const p = parseOr400(clientParam, req.params, reply);
    if (!p) return;
    const b = parseOr400(patchBody, req.body, reply);
    if (!b) return;
    if (!repos.siteClients.get(p.clientId)) return sendError(reply, 404, 'not_found', 'site not found');
    ctx.change(() => {
      repos.siteClients.update(p.clientId, toPatch(b, ctx.secrets), Date.now());
      ctx.audit.record(actorOf(req), 'site.update', 'site', p.clientId, changes(b));
    });
    reply.send({ site: siteView(ctx, repos.siteClients.get(p.clientId)!) });
  });

  app.post('/sites/:clientId/tokens', async (req, reply) => {
    const p = parseOr400(clientParam, req.params, reply);
    if (!p) return;
    const b = parseOr400(tokenBody, req.body, reply);
    if (!b) return;
    if (!repos.siteClients.get(p.clientId)) return sendError(reply, 404, 'not_found', 'site not found');
    const t = generateToken('site');
    const id = ctx.change(() => {
      const tokenId = repos.siteTokens.issue({ token_sha256: t.sha256, token_prefix: t.prefix, label: b.label ?? '', client_id: p.clientId }, Date.now());
      ctx.audit.record(actorOf(req), 'site_token.issue', 'site_token', tokenId, { clientId: p.clientId, label: b.label ?? '', prefix: t.prefix });
      return tokenId;
    });
    // Открытый токен — только в этом ответе; в БД лежит его sha256.
    reply.code(201).send({ token: tokenView(repos.siteTokens.get(id)!), plaintext: t.plaintext });
  });

  app.post('/sites/:clientId/tokens/:id/revoke', async (req, reply) => {
    const p = parseOr400(tokenParam, req.params, reply);
    if (!p) return;
    const tok = repos.siteTokens.get(p.id);
    if (!tok || tok.client_id !== p.clientId) return sendError(reply, 404, 'not_found', 'token not found');
    ctx.change(() => {
      repos.siteTokens.revoke(p.id, Date.now());
      ctx.audit.record(actorOf(req), 'site_token.revoke', 'site_token', p.id, { clientId: p.clientId, prefix: tok.token_prefix });
    });
    reply.send({ token: tokenView(repos.siteTokens.get(p.id)!) });
  });
}

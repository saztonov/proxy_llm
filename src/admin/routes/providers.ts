import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminCtx } from '../ctx.js';
import { parseOr400, sendError, idParam, optionalLimit, secretField } from '../validation.js';
import { actorOf } from '../audit.js';
import { checkProvider } from '../provider-check.js';
import { toAgentProvider } from '../../clients/agent-registry.js';
import { SecretBox } from '../../storage/secret-box.js';
import type { ProviderPatch, ProviderRow } from '../../storage/providers-repo.js';
import { validateProviderUrl, normalizeProviderUrl } from '../../upstream/provider-url.js';
import { validateExtraHeader, sanitizeExtraHeaders } from '../../upstream/provider-headers.js';

const USAGE = z.enum(['auto', 'openrouter', 'stream_options', 'none']);
const fields = {
  name: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, 'name: letters, digits, space . _ -'),
  baseUrl: z.string().trim().min(1).max(500),
  apiKey: secretField,
  extraHeaders: z.record(z.string(), z.string()).nullable().optional(),
  usageMode: USAGE.optional(),
  maxConcurrency: optionalLimit(500),
};
const createBody = z.object(fields).strict();
const patchBody = z.object({ ...fields, name: fields.name.optional(), baseUrl: fields.baseUrl.optional(), enabled: z.boolean().optional() }).strict();

type Issue = { path: string; message: string };

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function validateInput(b: { baseUrl?: string | undefined; extraHeaders?: Record<string, string> | null | undefined }, allowInsecure: boolean): Issue[] {
  const issues: Issue[] = [];
  if (b.baseUrl !== undefined) {
    const err = validateProviderUrl(normalizeProviderUrl(b.baseUrl), allowInsecure);
    if (err) issues.push({ path: 'baseUrl', message: err });
  }
  for (const [k, v] of Object.entries(b.extraHeaders ?? {})) {
    const err = validateExtraHeader(k, v);
    if (err) issues.push({ path: 'extraHeaders', message: err });
  }
  return issues;
}

export function providerView(ctx: AdminCtx, row: ProviderRow, defaultId: number | null) {
  let names: string[] = [];
  if (row.extra_headers_enc) {
    try {
      names = Object.keys(sanitizeExtraHeaders(JSON.parse(ctx.secrets.open(row.extra_headers_enc))));
    } catch {
      names = ['(не расшифровывается: проверьте SECRETS_ENCRYPTION_KEY)'];
    }
  }
  return {
    id: row.id, name: row.name, baseUrl: row.base_url, hasApiKey: row.api_key_enc !== null, apiKeyFp: row.api_key_fp,
    extraHeaderNames: names, usageMode: row.usage_mode, maxConcurrency: row.max_concurrency, enabled: row.enabled === 1,
    activeTokens: ctx.repos.providers.countActiveTokens(row.id), isDefault: row.id === defaultId,
  };
}

export async function registerProviderRoutes(app: FastifyInstance, ctx: AdminCtx): Promise<void> {
  const repo = ctx.repos.providers;
  const insecure = ctx.config.ADMIN_ALLOW_INSECURE_PROVIDERS;
  const defaultId = () => ctx.repos.settings.agentDefaults().providerId;
  const sealKey = (k: string | null) => ({ api_key_enc: k === null ? null : ctx.secrets.seal(k), api_key_fp: k === null ? null : SecretBox.fingerprint(k) });
  const sealHeaders = (h: Record<string, string> | null) => (h === null || Object.keys(h).length === 0 ? null : ctx.secrets.seal(JSON.stringify(h)));

  app.get('/providers', async (_req, reply) => {
    const d = defaultId();
    reply.send({ providers: repo.list().map((r) => providerView(ctx, r, d)) });
  });

  app.post('/providers', async (req, reply) => {
    const b = parseOr400(createBody, req.body, reply);
    if (!b) return;
    const issues = validateInput(b, insecure);
    if (issues.length) return sendError(reply, 400, 'invalid_request', 'validation failed', { issues });
    const baseUrl = normalizeProviderUrl(b.baseUrl);
    const id = ctx.change(() => {
      const newId = repo.create({
        name: b.name, base_url: baseUrl, ...sealKey(b.apiKey ?? null), extra_headers_enc: sealHeaders(b.extraHeaders ?? null),
        usage_mode: b.usageMode ?? 'auto', max_concurrency: b.maxConcurrency ?? null,
      }, Date.now());
      ctx.audit.record(actorOf(req), 'provider.create', 'provider', newId, { name: b.name, baseUrl, usageMode: b.usageMode ?? 'auto', apiKeyChanged: Boolean(b.apiKey) });
      return newId;
    });
    reply.code(201).send({ provider: providerView(ctx, repo.get(id)!, defaultId()) });
  });

  app.patch('/providers/:id', async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const b = parseOr400(patchBody, req.body, reply);
    if (!b) return;
    const row = repo.get(p.id);
    if (!row) return sendError(reply, 404, 'not_found', 'provider not found');
    const issues = validateInput(b, insecure);
    if (issues.length) return sendError(reply, 400, 'invalid_request', 'validation failed', { issues });
    if (b.enabled === false && defaultId() === p.id) {
      return sendError(reply, 409, 'provider_is_default', 'this provider serves the global default model; change the default first');
    }
    // Ключ провайдера уходит на его base URL. Смена хоста без повторного ввода секретов
    // позволила бы увести сохранённый ключ на свой сервер, хотя прочитать его API не даёт.
    const fromOrigin = originOf(row.base_url);
    const toOrigin = b.baseUrl !== undefined ? originOf(normalizeProviderUrl(b.baseUrl)) : fromOrigin;
    const originChanged = toOrigin !== fromOrigin;
    if (originChanged) {
      const missing: Issue[] = [];
      if (row.api_key_enc !== null && b.apiKey === undefined) missing.push({ path: 'apiKey', message: 'Введите ключ заново: меняется хост провайдера' });
      if (row.extra_headers_enc !== null && b.extraHeaders === undefined) missing.push({ path: 'extraHeaders', message: 'Введите заголовки заново: меняется хост провайдера' });
      if (missing.length) {
        return sendError(reply, 409, 'reenter_secrets',
          'При смене хоста провайдера ключ API и дополнительные заголовки нужно ввести заново.', { issues: missing });
      }
    }
    const patch: ProviderPatch = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.baseUrl !== undefined) patch.base_url = normalizeProviderUrl(b.baseUrl);
    if (b.apiKey !== undefined) Object.assign(patch, sealKey(b.apiKey));
    if (b.extraHeaders !== undefined) patch.extra_headers_enc = sealHeaders(b.extraHeaders);
    if (b.usageMode !== undefined) patch.usage_mode = b.usageMode;
    if (b.maxConcurrency !== undefined) patch.max_concurrency = b.maxConcurrency;
    if (b.enabled !== undefined) patch.enabled = b.enabled ? 1 : 0;
    ctx.change(() => {
      repo.update(p.id, patch, Date.now());
      ctx.audit.record(actorOf(req), 'provider.update', 'provider', p.id, {
        fields: Object.keys(b).filter((k) => k !== 'apiKey' && k !== 'extraHeaders'),
        apiKeyChanged: b.apiKey !== undefined, extraHeadersChanged: b.extraHeaders !== undefined,
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
        ...(originChanged ? { originChanged: true, baseUrl: toOrigin } : {}),
      });
    });
    if (originChanged) ctx.alerts.onProviderOriginChanged(row.name, fromOrigin, toOrigin, req.ip).catch(() => undefined);
    reply.send({ provider: providerView(ctx, repo.get(p.id)!, defaultId()) });
  });

  app.post('/providers/:id/test', async (req, reply) => {
    const p = parseOr400(idParam, req.params, reply);
    if (!p) return;
    const row = repo.get(p.id);
    if (!row) return sendError(reply, 404, 'not_found', 'provider not found');
    const result = await checkProvider(toAgentProvider(row, ctx.secrets), ctx.config.ADMIN_PROVIDER_CHECK_TIMEOUT_MS);
    ctx.audit.record(actorOf(req), 'provider.test', 'provider', p.id, { ok: result.ok, httpStatus: result.httpStatus });
    reply.send(result);
  });
}

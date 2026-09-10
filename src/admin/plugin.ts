import type { FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import type { AdminDeps } from './context.js';
import type { AdminCtx } from './ctx.js';
import { deriveAdminKeys } from './auth/keys.js';
import { SessionService } from './auth/session-service.js';
import { makeAuthHooks } from './auth/hooks.js';
import { AuditLog } from './audit.js';
import { AdminRenderer } from './render.js';
import { applyChange } from './registry-tx.js';
import { adminOriginGuard, adminSecurityHeaders } from './security.js';
import { sendError } from './validation.js';
import { ConflictError } from '../storage/errors.js';
import { sanitizeErrorForLog } from '../utils/sanitize-error.js';
import { registerPageRoutes } from './routes/pages.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerSiteRoutes } from './routes/sites.js';
import { registerDirectoryRoutes } from './routes/directory.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerAgentTokenRoutes } from './routes/agent-tokens.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerStatsRoutes } from './routes/stats.js';

export interface AdminPluginOptions {
  deps: AdminDeps;
}

/** JSON админки — маленький; 26 МБ контура сайтов здесь не нужны. */
const ADMIN_BODY_LIMIT = 64 * 1024;

/**
 * Админ-сайт (/admin): страницы на Eta + JSON API. Инкапсулированный плагин: cookie-плагин,
 * заголовки безопасности, проверка Origin и обработчики ошибок действуют только здесь;
 * контур сайтов и старый /dashboard не затрагиваются.
 */
export async function adminPlugin(app: FastifyInstance, opts: AdminPluginOptions): Promise<void> {
  const d = opts.deps;
  const keys = deriveAdminKeys(d.config.ADMIN_JWT_SECRET);
  const sessions = new SessionService({ config: d.config, users: d.repos.adminUsers, sessions: d.repos.adminSessions, keys, logger: d.logger });
  const registries = { site: d.siteRegistry, agent: d.agentRegistry };
  const ctx: AdminCtx = {
    ...d,
    sessions,
    keys,
    hooks: makeAuthHooks(sessions, keys),
    audit: new AuditLog(d.repos.audit, d.repos.adminUsers, d.logger),
    renderer: new AdminRenderer(d.config.NODE_ENV === 'production', d.logger),
    change: <T>(fn: () => T): T => applyChange(d.db, registries, fn),
  };

  await app.register(fastifyCookie);
  app.addHook('onRoute', (route) => {
    if (route.bodyLimit === undefined) route.bodyLimit = ADMIN_BODY_LIMIT;
  });
  app.addHook('onRequest', adminOriginGuard);
  app.addHook('onSend', adminSecurityHeaders);

  app.setErrorHandler((err, req, reply) => {
    const e = err as { statusCode?: number; message?: string };
    if (err instanceof ConflictError) {
      sendError(reply, 409, 'conflict', err.message);
    } else if (e.statusCode === 413) {
      sendError(reply, 413, 'payload_too_large', 'request body is too large');
    } else if (e.statusCode === 415) {
      sendError(reply, 415, 'unsupported_media_type', 'use Content-Type: application/json');
    } else if (e.statusCode !== undefined && e.statusCode >= 400 && e.statusCode < 500) {
      sendError(reply, e.statusCode, 'invalid_request', e.message ?? 'bad request');
    } else {
      d.logger.error({ err: sanitizeErrorForLog(err), url: req.url.split('?')[0] }, 'admin route error');
      sendError(reply, 500, 'internal', 'internal error');
    }
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/admin/api/')) {
      sendError(reply, 404, 'not_found', 'not found');
      return;
    }
    try {
      reply.code(404).type('text/html; charset=utf-8').send(ctx.renderer.render('404', { title: 'Не найдено' }));
    } catch {
      sendError(reply, 404, 'not_found', 'not found');
    }
  });

  await registerPageRoutes(app, ctx);
  await registerAuthRoutes(app, ctx);
  await app.register(
    async (api) => {
      api.addHook('onRequest', ctx.hooks.requireAccess);
      api.addHook('preHandler', ctx.hooks.requireCsrf);
      await registerSiteRoutes(api, ctx);
      await registerDirectoryRoutes(api, ctx);
      await registerProviderRoutes(api, ctx);
      await registerAgentTokenRoutes(api, ctx);
      await registerSettingsRoutes(api, ctx);
      await registerStatsRoutes(api, ctx);
    },
    { prefix: '/api' },
  );
}

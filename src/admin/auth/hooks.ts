import type { FastifyReply, FastifyRequest } from 'fastify';
import { AT_COOKIE } from './cookies.js';
import { csrfValid, SAFE_METHODS } from './csrf.js';
import type { AdminKeys } from './keys.js';
import type { SessionService } from './session-service.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Проверенная сессия администратора (подпись JWT + живая цепочка в БД). */
    adminSession?: { adminId: number; sid: string };
  }
}

export interface AuthHooks {
  requireAccess(req: FastifyRequest, reply: FastifyReply): Promise<void>;
  requirePage(req: FastifyRequest, reply: FastifyReply): Promise<void>;
  requireCsrf(req: FastifyRequest, reply: FastifyReply): Promise<void>;
}

/** Куда можно вернуться после входа: только внутрь админки, без протокол-относительных URL. */
export function safeNext(raw: unknown): string {
  return typeof raw === 'string' && /^\/admin(\/|\?|$)/.test(raw) && !raw.startsWith('//') && !raw.includes(String.fromCharCode(92))
    ? raw
    : '/admin';
}

export function makeAuthHooks(sessions: SessionService, keys: AdminKeys): AuthHooks {
  return {
    async requireAccess(req, reply) {
      const claims = sessions.verifyAccess(req.cookies[AT_COOKIE]);
      if (!claims) {
        reply.code(401).send({ error: { code: 'unauthorized', message: 'login required' } });
        return;
      }
      req.adminSession = { adminId: claims.sub, sid: claims.sid };
    },
    // Страницы — только проверка access; при истёкшем редирект на вход, где JS тихо обновит
    // пару через refresh и вернёт на next. HTML-роуты refresh-cookie не видят вовсе.
    async requirePage(req, reply) {
      const claims = sessions.verifyAccess(req.cookies[AT_COOKIE]);
      if (!claims) {
        reply.redirect(`/admin/login?next=${encodeURIComponent(safeNext(req.url))}`, 302);
        return;
      }
      req.adminSession = { adminId: claims.sub, sid: claims.sid };
    },
    // Synchronizer-токен = HMAC(ключ, sid): хранить не нужно, чужая вкладка его не знает.
    async requireCsrf(req, reply) {
      if (SAFE_METHODS.has(req.method)) return;
      const s = req.adminSession;
      if (!s || !csrfValid(keys.csrf, s.sid, req.headers['x-csrf-token'])) {
        reply.code(403).send({ error: { code: 'csrf_invalid', message: 'missing or invalid CSRF token' } });
      }
    },
  };
}

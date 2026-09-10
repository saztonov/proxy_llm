import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AdminCtx } from '../ctx.js';
import { setAuthCookies, clearAuthCookies, AT_COOKIE, RT_COOKIE } from '../auth/cookies.js';
import type { ClientMeta } from '../auth/session-service.js';
import { parseOr400, sendError } from '../validation.js';
import { WindowRateLimiter } from '../../agent/limiters.js';

const loginBody = z.object({ login: z.string().trim().min(1).max(64), password: z.string().min(1).max(1024) }).strict();
const changeBody = z.object({ current: z.string().min(1).max(1024), next: z.string().min(1).max(1024) }).strict();

function meta(req: FastifyRequest): ClientMeta {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: typeof ua === 'string' ? ua : null };
}

export async function registerAuthRoutes(app: FastifyInstance, ctx: AdminCtx): Promise<void> {
  const cfg = ctx.config;
  const secure = cfg.ADMIN_COOKIE_SECURE;
  const windowMs = cfg.ADMIN_LOGIN_WINDOW_SEC * 1000;
  // Per-IP поверх per-login: перебор паролей к разным логинам с одного адреса.
  const loginByIp = new WindowRateLimiter(cfg.ADMIN_LOGIN_IP_MAX, windowMs);
  const refreshByIp = new WindowRateLimiter(Math.max(60, cfg.ADMIN_LOGIN_IP_MAX * 6), windowMs);

  const limited = (limiter: WindowRateLimiter, req: FastifyRequest, reply: Parameters<typeof sendError>[0]): boolean => {
    const rl = limiter.hit(req.ip);
    if (rl.allowed) return false;
    reply.header('retry-after', String(rl.retryAfterSec));
    sendError(reply, 429, 'rate_limited', 'too many attempts', { retryAfterSec: rl.retryAfterSec });
    return true;
  };

  app.post('/api/auth/login', async (req, reply) => {
    if (limited(loginByIp, req, reply)) return;
    const body = parseOr400(loginBody, req.body, reply);
    if (!body) return;
    const out = await ctx.sessions.login(body.login, body.password, meta(req));
    if (out.kind === 'busy') {
      reply.header('retry-after', '2');
      sendError(reply, 503, 'busy', 'server is busy, retry in a few seconds');
      return;
    }
    if (out.kind === 'locked') {
      reply.header('retry-after', String(out.retryAfterSec));
      sendError(reply, 429, 'rate_limited', 'too many failed attempts for this login', { retryAfterSec: out.retryAfterSec });
      return;
    }
    if (out.kind === 'invalid') {
      // Один ответ для неверного пароля, несуществующего и отключённого логина.
      // Логин пишем, только если такой админ есть: иначе в журнал и в Telegram попал бы пароль,
      // по ошибке набранный в поле логина.
      const known = ctx.repos.adminUsers.getByLogin(body.login.trim()) !== null;
      const shownLogin = known ? body.login.trim() : null;
      ctx.audit.record({ adminId: null, ip: req.ip }, 'auth.login_failed', 'admin', null, { login: shownLogin, knownLogin: known, failures: out.failures });
      if (out.failures >= cfg.ADMIN_LOGIN_MAX_ATTEMPTS) {
        ctx.alerts.onAdminLoginFailures(shownLogin, req.ip, out.failures).catch(() => undefined);
      }
      sendError(reply, 401, 'invalid_credentials', 'invalid login or password');
      return;
    }
    setAuthCookies(reply, out.session, secure);
    ctx.audit.record({ adminId: out.session.admin.id, ip: req.ip }, 'auth.login', 'admin', out.session.admin.id);
    reply.send({ admin: out.session.admin, csrf: out.session.csrf });
  });

  app.post('/api/auth/refresh', async (req, reply) => {
    if (limited(refreshByIp, req, reply)) return;
    const out = ctx.sessions.refresh(req.cookies[RT_COOKIE], meta(req));
    if (out.kind === 'ok') {
      setAuthCookies(reply, out.session, secure);
      reply.send({ csrf: out.session.csrf });
      return;
    }
    if (out.kind === 'conflict') {
      sendError(reply, 409, 'refresh_conflict', 'session was just refreshed by another tab');
      return;
    }
    clearAuthCookies(reply, secure);
    if (out.kind === 'reuse') {
      const id = out.admin?.id ?? null;
      ctx.audit.record({ adminId: id, ip: req.ip }, 'auth.refresh_reuse', 'admin', id, { reason: 'refresh token reuse' });
      if (out.admin) ctx.alerts.onAdminSessionReuse(out.admin.login, req.ip).catch(() => undefined);
    }
    sendError(reply, 401, 'unauthorized', 'login required');
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const claims = ctx.sessions.verifyAccess(req.cookies[AT_COOKIE]);
    ctx.sessions.logout({ sid: claims?.sid, refresh: req.cookies[RT_COOKIE] });
    clearAuthCookies(reply, secure);
    if (claims) ctx.audit.record({ adminId: claims.sub, ip: req.ip }, 'auth.logout', 'admin', claims.sub);
    reply.code(204).send();
  });

  await app.register(async (s) => {
    s.addHook('onRequest', ctx.hooks.requireAccess);
    s.addHook('preHandler', ctx.hooks.requireCsrf);

    s.get('/api/auth/me', async (req, reply) => {
      const admin = ctx.sessions.admin(req.adminSession!.adminId);
      if (!admin) return sendError(reply, 401, 'unauthorized', 'login required');
      reply.send({ admin, csrf: ctx.sessions.csrfFor(req.adminSession!.sid) });
    });

    s.post('/api/auth/change-password', async (req, reply) => {
      const body = parseOr400(changeBody, req.body, reply);
      if (!body) return;
      const out = await ctx.sessions.changePassword(req.adminSession!.adminId, body.current, body.next);
      if (out.kind === 'busy') return sendError(reply, 503, 'busy', 'server is busy, retry in a few seconds');
      if (out.kind === 'locked') {
        reply.header('retry-after', String(out.retryAfterSec));
        return sendError(reply, 429, 'rate_limited', 'too many failed attempts', { retryAfterSec: out.retryAfterSec });
      }
      if (out.kind === 'weak') return sendError(reply, 400, 'invalid_request', out.message, { issues: [{ path: 'next', message: out.message }] });
      if (out.kind === 'invalid') return sendError(reply, 400, 'invalid_credentials', 'current password is wrong', { issues: [{ path: 'current', message: 'wrong password' }] });
      ctx.audit.record({ adminId: req.adminSession!.adminId, ip: req.ip }, 'auth.password_changed', 'admin', req.adminSession!.adminId);
      clearAuthCookies(reply, secure);
      reply.code(204).send();
    });
  });
}

import type { FastifyReply } from 'fastify';

export const AT_COOKIE = 'admin_at';
export const RT_COOKIE = 'admin_rt';
/** Access-cookie видят все страницы и API админки. */
export const AT_PATH = '/admin';
/** Refresh-cookie уходит только на эндпоинты аутентификации — меньше мест, где он виден. */
export const RT_PATH = '/admin/api/auth';

export interface IssuedCookies {
  access: string;
  accessTtlSec: number;
  refresh: string;
  refreshExpiresAt: number;
}

/**
 * httpOnly — токены недоступны JS, XSS их не украдёт; SameSite=Strict — браузер не пришлёт их
 * с чужого сайта; Secure — только по HTTPS (в проде). Префикс __Host- не подходит: он требует
 * Path=/, а refresh намеренно ограничен путём аутентификации.
 */
export function setAuthCookies(reply: FastifyReply, c: IssuedCookies, secure: boolean, now = Date.now()): void {
  const base = { httpOnly: true, secure, sameSite: 'strict' as const };
  reply.setCookie(AT_COOKIE, c.access, { ...base, path: AT_PATH, maxAge: c.accessTtlSec });
  reply.setCookie(RT_COOKIE, c.refresh, {
    ...base,
    path: RT_PATH,
    maxAge: Math.max(0, Math.floor((c.refreshExpiresAt - now) / 1000)),
  });
}

export function clearAuthCookies(reply: FastifyReply, secure: boolean): void {
  const base = { httpOnly: true, secure, sameSite: 'strict' as const };
  reply.clearCookie(AT_COOKIE, { ...base, path: AT_PATH });
  reply.clearCookie(RT_COOKIE, { ...base, path: RT_PATH });
}

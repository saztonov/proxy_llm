import type { FastifyReply, FastifyRequest } from 'fastify';
import { isSameOrigin, SAFE_METHODS } from './auth/csrf.js';

/**
 * CSP без 'unsafe-inline': в шаблонах нет inline-скриптов, стилей и обработчиков, поэтому даже
 * внедрённая разметка не исполнится. frame-ancestors 'none' — защита от clickjacking.
 */
export const ADMIN_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

export async function adminSecurityHeaders(req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> {
  reply.header('content-security-policy', ADMIN_CSP);
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('cross-origin-opener-policy', 'same-origin');
  reply.header('cross-origin-resource-policy', 'same-origin');
  reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('x-robots-tag', 'noindex, nofollow');
  if (!req.url.startsWith('/admin/static/')) reply.header('cache-control', 'no-store');
  return payload;
}

/**
 * Защита от CSRF в глубину, независимо от SameSite и CSRF-токена: мутирующий запрос к API
 * админки принимается только same-origin (Origin/Sec-Fetch-Site), включая login и refresh.
 */
export async function adminOriginGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (SAFE_METHODS.has(req.method) || !req.url.startsWith('/admin/api/')) return;
  if (!isSameOrigin({ method: req.method, headers: req.headers, host: req.host })) {
    reply.code(403).send({ error: { code: 'bad_origin', message: 'cross-origin request rejected' } });
  }
}

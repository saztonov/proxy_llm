import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ClientRegistry, ClientConfig } from '../clients/registry.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Клиент, резолвнутый по Bearer-токену (выставляется bearerAuth). */
    authClient?: ClientConfig;
  }
}

/**
 * Проверка Bearer-токена через реестр клиентов. Резолв — timing-safe (sha256 + Map,
 * см. ClientRegistry). При успехе кладёт ClientConfig в req.authClient; при неудаче — 401.
 */
export function makeBearerAuthHook(registry: ClientRegistry) {
  return async function bearerAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'missing bearer token' } });
      return;
    }
    const client = registry.resolveToken(header.slice('Bearer '.length));
    if (!client) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'invalid bearer token' } });
      return;
    }
    req.authClient = client;
  };
}

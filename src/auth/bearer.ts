import type { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

export function makeBearerAuthHook(token: string) {
  const expected = Buffer.from(token, 'utf8');

  return async function bearerAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'missing bearer token' } });
      return;
    }
    const got = Buffer.from(header.slice('Bearer '.length), 'utf8');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      reply.code(401).send({ error: { code: 'unauthorized', message: 'invalid bearer token' } });
      return;
    }
  };
}

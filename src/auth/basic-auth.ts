import type { FastifyInstance } from 'fastify';
import fastifyBasicAuth from '@fastify/basic-auth';
import { timingSafeEqual } from 'node:crypto';

export interface BasicAuthOptions {
  user: string;
  password: string;
}

export async function registerBasicAuth(
  app: FastifyInstance,
  opts: BasicAuthOptions,
): Promise<void> {
  const expectedUser = Buffer.from(opts.user, 'utf8');
  const expectedPass = Buffer.from(opts.password, 'utf8');

  await app.register(fastifyBasicAuth, {
    validate: async (username, password) => {
      const u = Buffer.from(username, 'utf8');
      const p = Buffer.from(password, 'utf8');
      const userOk =
        u.length === expectedUser.length && timingSafeEqual(u, expectedUser);
      const passOk =
        p.length === expectedPass.length && timingSafeEqual(p, expectedPass);
      if (!userOk || !passOk) {
        throw new Error('invalid credentials');
      }
    },
    authenticate: { realm: 'proxy_llm' },
  });
}

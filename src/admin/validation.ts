import { z } from 'zod';
import type { FastifyReply } from 'fastify';

export function sendError(reply: FastifyReply, status: number, code: string, message: string, extra: Record<string, unknown> = {}): void {
  reply.code(status).send({ error: { code, message, ...extra } });
}

/** zod safeParse → 400 с issues по полям; undefined — ответ уже отправлен. */
export function parseOr400<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown, reply: FastifyReply): T | undefined {
  const r = schema.safeParse(input ?? {});
  if (r.success) return r.data;
  sendError(reply, 400, 'invalid_request', 'validation failed', {
    issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
  return undefined;
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });

export const modelSlug = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:/@+-]+$/, 'model id: letters, digits and . _ : / @ + -');

export const optionalLimit = (max: number) => z.number().int().min(1).max(max).nullable().optional();

/** Строка «оставить как есть» / удалить (null) / заменить. Пустая строка трактуется как «не менять». */
export const secretField = z
  .string()
  .max(1000)
  .nullable()
  .optional()
  .transform((v) => (typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v));

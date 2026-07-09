import { z } from 'zod';

/**
 * Схема файла реестра клиентов (clients.json).
 * Токены задаются либо в открытом виде (`tokens`), либо как sha256-хэши (`tokenSha256`),
 * либо и так и так. Всё остальное — опционально, дефолты берутся из env-config.
 */
export const clientEntrySchema = z
  .object({
    clientId: z.string().min(1),
    tokens: z.array(z.string().min(16)).optional(),
    tokenSha256: z.array(z.string().regex(/^[0-9a-fA-F]{64}$/)).optional(),
    defaultModel: z.string().min(1).optional(),
    allowedModels: z.array(z.string().min(1)).optional(),
    fallbackModels: z.array(z.string().min(1)).optional(),
    maxConcurrency: z.coerce.number().int().min(1).max(20).optional(),
    maxPending: z.coerce.number().int().min(1).max(1000).optional(),
    openrouterApiKey: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (e) => (e.tokens?.length ?? 0) + (e.tokenSha256?.length ?? 0) > 0,
    { message: 'client must define at least one token (tokens or tokenSha256)' },
  );

export const clientsFileSchema = z
  .object({
    clients: z.array(clientEntrySchema).min(1),
  })
  .strict();

export type ClientEntry = z.infer<typeof clientEntrySchema>;
export type ClientsFile = z.infer<typeof clientsFileSchema>;

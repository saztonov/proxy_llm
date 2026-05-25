import type { Readable } from 'node:stream';

export class UpstreamResponseTooLargeError extends Error {
  override readonly name = 'UpstreamResponseTooLargeError';
  constructor(readonly limit: number) {
    super(`upstream response exceeded ${limit} bytes`);
  }
}

/**
 * Читает поток до limit байт. При превышении — abort'ит поток и кидает
 * UpstreamResponseTooLargeError. Защищает от мусорных/циклических ответов провайдера.
 */
export async function readBodyWithLimit(stream: Readable, limit: number): Promise<string> {
  let total = 0;
  const chunks: Buffer[] = [];
  try {
    for await (const chunkRaw of stream) {
      const chunk = Buffer.isBuffer(chunkRaw) ? chunkRaw : Buffer.from(chunkRaw);
      total += chunk.length;
      if (total > limit) {
        stream.destroy();
        throw new UpstreamResponseTooLargeError(limit);
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof UpstreamResponseTooLargeError) throw err;
    throw err;
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

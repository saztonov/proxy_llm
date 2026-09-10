import type { ServerResponse } from 'node:http';

export interface ChunkExtra {
  id?: string;
  model?: string;
  finish_reason?: string | null;
  usage?: Record<string, unknown>;
}

/** Чанк chat-стрима OpenAI. content=null — чанк без choices (как итоговый usage-чанк). */
export function chatChunk(content: string | null, extra: ChunkExtra = {}): Record<string, unknown> {
  return {
    id: extra.id ?? 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: extra.model ?? 'mock/model',
    choices: content === null ? [] : [{ index: 0, delta: { content }, finish_reason: extra.finish_reason ?? null }],
    ...(extra.usage ? { usage: extra.usage } : {}),
  };
}

export interface SseOptions {
  delayMs?: number;
  /** false — поток закрывается без [DONE]. */
  done?: boolean;
  /** Комментарий keep-alive до первого события (как у OpenRouter). */
  keepalive?: boolean;
  /** Провайдер «завис» после событий: соединение открыто, данных нет. */
  hangAfter?: boolean;
}

export interface SseHandle {
  /** Прокси закрыл соединение раньше, чем мок дописал поток. */
  closedByPeer(): boolean;
  finished: Promise<void>;
}

export function sseResponse(res: ServerResponse, events: Array<Record<string, unknown> | string>, opts: SseOptions = {}): SseHandle {
  let closed = false;
  res.on('close', () => {
    if (!res.writableFinished) closed = true;
  });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  if (opts.keepalive) res.write(': OPENROUTER PROCESSING\n\n');
  const finished = (async () => {
    for (const ev of events) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (closed) return;
      res.write(`data: ${typeof ev === 'string' ? ev : JSON.stringify(ev)}\n\n`);
    }
    if (opts.hangAfter || closed) return;
    if (opts.done !== false) res.write('data: [DONE]\n\n');
    res.end();
  })();
  return { closedByPeer: () => closed, finished };
}

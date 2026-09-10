import type { FastifyReply } from 'fastify';

export class ClientClosedError extends Error {
  override readonly name = 'ClientClosedError';
  constructor() {
    super('client closed the connection');
  }
}

/** Куда стримится ответ агенту. Интерфейс — чтобы клиент провайдера не знал про Fastify. */
export interface StreamSink {
  readonly committed: boolean;
  /** Отправить 200 и заголовки. После этого ретрай невозможен. */
  commit(headers: Record<string, string>): void;
  /** Запись с backpressure; бросает ClientClosedError, если клиент ушёл, или причину abort. */
  write(chunk: Buffer | string, signal?: AbortSignal): Promise<void>;
  end(): void;
  clientClosed(): boolean;
}

/**
 * Стрим поверх reply.raw. Обрыв клиента ловится по 'close' без writableFinished: onRequestAbort
 * Fastify срабатывает только пока тело запроса ещё читается, а стрим идёт уже после.
 */
export class ReplyStreamSink implements StreamSink {
  private closed = false;
  private isCommitted = false;
  private readonly closeCallbacks: Array<() => void> = [];

  constructor(private readonly reply: FastifyReply) {
    reply.raw.once('close', () => {
      if (reply.raw.writableFinished) return;
      this.closed = true;
      for (const cb of this.closeCallbacks.splice(0)) cb();
    });
  }

  get committed(): boolean {
    return this.isCommitted;
  }

  clientClosed(): boolean {
    return this.closed;
  }

  /** Колбэк на обрыв клиента (например, abort запроса к провайдеру). */
  onClose(cb: () => void): void {
    if (this.closed) cb();
    else this.closeCallbacks.push(cb);
  }

  commit(headers: Record<string, string>): void {
    if (this.isCommitted) return;
    this.isCommitted = true;
    this.reply.hijack();
    // Чанки SSE — маленькие; без Nagle они уходят сразу. В inject-тестах сокет — заглушка.
    const socket = this.reply.raw.socket as { setNoDelay?: (v: boolean) => void } | null;
    if (socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
    this.reply.raw.writeHead(200, headers);
    this.reply.raw.flushHeaders();
  }

  async write(chunk: Buffer | string, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new ClientClosedError();
    const res = this.reply.raw;
    if (res.write(chunk)) return;
    // Медленный клиент: не копим провайдерский поток в памяти, ждём drain.
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        res.off('drain', onDrain);
        res.off('close', onClose);
        signal?.removeEventListener('abort', onAbort);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onClose = (): void => {
        cleanup();
        reject(new ClientClosedError());
      };
      const onAbort = (): void => {
        cleanup();
        reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
      };
      res.once('drain', onDrain);
      res.once('close', onClose);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  end(): void {
    if (!this.closed && !this.reply.raw.writableEnded) this.reply.raw.end();
  }
}

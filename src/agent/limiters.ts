import PQueue from 'p-queue';

/**
 * Фиксированное окно запросов на ключ (владелец токена). Свой класс вместо @fastify/rate-limit:
 * ключ известен только после аутентификации, а 429 нужен в формате OpenAI.
 */
export class WindowRateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private lastPrune = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** allowed=false → retryAfterSec до конца окна. */
  hit(key: string): { allowed: boolean; retryAfterSec: number; remaining: number } {
    const now = this.now();
    this.prune(now);
    let h = this.hits.get(key);
    if (!h || h.resetAt <= now) {
      h = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, h);
    }
    h.count += 1;
    const retryAfterSec = Math.max(1, Math.ceil((h.resetAt - now) / 1000));
    return { allowed: h.count <= this.max, retryAfterSec, remaining: Math.max(0, this.max - h.count) };
  }

  private prune(now: number): void {
    if (now - this.lastPrune < this.windowMs) return;
    this.lastPrune = now;
    for (const [k, h] of this.hits) if (h.resetAt <= now) this.hits.delete(k);
  }
}

/**
 * Потолок одновременных запросов к одному провайдеру. Нужен, когда у провайдера жёсткий
 * RPM/concurrency-лимит: иначе десятки агентов разом получают шторм 429.
 */
export class ProviderLimiter {
  private readonly queues = new Map<number, PQueue>();

  run<T>(providerId: number, limit: number | null, fn: () => Promise<T>): Promise<T> {
    if (limit === null) return fn();
    let q = this.queues.get(providerId);
    if (!q) {
      q = new PQueue({ concurrency: limit });
      this.queues.set(providerId, q);
    } else if (q.concurrency !== limit) {
      q.concurrency = limit;
    }
    return q.add(fn, { throwOnTimeout: true }) as Promise<T>;
  }

  pending(providerId: number): number {
    const q = this.queues.get(providerId);
    return q ? q.pending + q.size : 0;
  }
}

/** Скользящий счётчик неудачных аутентификаций для алерта (без привязки к cooldown Telegram). */
export class AuthFailureMonitor {
  private events: Array<{ ts: number; ip: string }> = [];

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  record(ip: string): { count: number; topIps: string[] } {
    const now = this.now();
    this.events.push({ ts: now, ip });
    this.events = this.events.filter((e) => now - e.ts <= this.windowMs);
    const byIp = new Map<string, number>();
    for (const e of this.events) byIp.set(e.ip, (byIp.get(e.ip) ?? 0) + 1);
    const topIps = [...byIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ip, n]) => `${ip}×${n}`);
    return { count: this.events.length, topIps };
  }
}

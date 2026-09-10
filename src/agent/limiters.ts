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

/**
 * Скользящий счётчик неудачных аутентификаций для алерта.
 *
 * Эндпоинт публичный, поэтому поток неверных токенов не должен ни раздувать память, ни делать
 * каждый отказ O(n): события хранятся с потолком, топ IP считается только при отправке
 * алерта, а сама отправка — не чаще раза в минуту (cooldown Telegram — ещё одна ступень).
 */
export class AuthFailureMonitor {
  static readonly MAX_EVENTS = 5_000;
  private events: Array<{ ts: number; ip: string }> = [];
  private lastNotifiedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly notifyEveryMs = 60_000,
  ) {}

  /** Регистрирует отказ; возвращает число отказов в окне (не больше MAX_EVENTS). */
  record(ip: string): number {
    const now = this.now();
    this.events.push({ ts: now, ip });
    let expired = 0;
    while (expired < this.events.length && now - this.events[expired]!.ts > this.windowMs) expired++;
    const overflow = Math.max(0, this.events.length - expired - AuthFailureMonitor.MAX_EVENTS);
    if (expired + overflow > 0) this.events.splice(0, expired + overflow);
    return this.events.length;
  }

  static readonly LOG_BURST = 20;
  static readonly LOG_WINDOW_MS = 10_000;
  private logWindowStart = Number.NEGATIVE_INFINITY;
  private logged = 0;
  private suppressed = 0;

  /**
   * Писать ли в лог строку об этом отказе: не больше LOG_BURST строк за LOG_WINDOW_MS.
   * suppressed — сколько строк пропущено в прошлом окне (сообщается в первой строке нового).
   */
  logDecision(): { log: boolean; suppressed: number } {
    const now = this.now();
    if (now - this.logWindowStart >= AuthFailureMonitor.LOG_WINDOW_MS) {
      const suppressed = this.suppressed;
      this.logWindowStart = now;
      this.logged = 1;
      this.suppressed = 0;
      return { log: true, suppressed };
    }
    if (this.logged < AuthFailureMonitor.LOG_BURST) {
      this.logged += 1;
      return { log: true, suppressed: 0 };
    }
    this.suppressed += 1;
    return { log: false, suppressed: 0 };
  }

  /** true — пора отправить алерт (и отметка «отправлено» уже поставлена). */
  shouldNotify(): boolean {
    const now = this.now();
    if (now - this.lastNotifiedAt < this.notifyEveryMs) return false;
    this.lastNotifiedAt = now;
    return true;
  }

  topIps(limit = 5): string[] {
    const byIp = new Map<string, number>();
    for (const e of this.events) byIp.set(e.ip, (byIp.get(e.ip) ?? 0) + 1);
    return [...byIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([ip, n]) => `${ip}×${n}`);
  }
}

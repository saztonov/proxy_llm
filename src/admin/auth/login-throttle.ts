export interface LoginThrottleOptions {
  /** Сколько неудач в окне допускается до блокировки. */
  maxAttempts: number;
  /** Длина скользящего окна, мс. */
  windowMs: number;
  /** Источник времени (мс) — инжектируется в тестах. */
  now?: () => number;
}

export interface LoginThrottleCheck {
  allowed: boolean;
  /** Секунд до разблокировки (0, если allowed). */
  retryAfterSec: number;
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

/**
 * Per-login sliding window в памяти. Логин нормализуется trim+lowercase.
 * Старые неудачи вычищаются при каждом вызове — Map не растёт бесконечно.
 * Состояние не переживает рестарт процесса и не разделяется между инстансами.
 */
export class LoginThrottle {
  private readonly maxAttempts: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  /** login → отметки времени неудач по возрастанию (только внутри окна). */
  private readonly failures = new Map<string, number[]>();

  constructor(opts: LoginThrottleOptions) {
    if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1) {
      throw new RangeError('maxAttempts must be a positive integer');
    }
    if (!Number.isFinite(opts.windowMs) || opts.windowMs <= 0) {
      throw new RangeError('windowMs must be a positive number');
    }
    this.maxAttempts = opts.maxAttempts;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
  }

  /**
   * allowed=false, если неудач в окне >= maxAttempts. retryAfterSec — до момента,
   * когда число неудач в окне снова станет < maxAttempts (при ровно maxAttempts
   * неудачах это выход самой старой из окна); ceil, не меньше 1.
   */
  check(login: string): LoginThrottleCheck {
    const now = this.now();
    this.prune(now);
    const stamps = this.failures.get(normalizeLogin(login));
    if (stamps === undefined || stamps.length < this.maxAttempts) {
      return { allowed: true, retryAfterSec: 0 };
    }
    const releaseAt = stamps[stamps.length - this.maxAttempts] + this.windowMs;
    const retryAfterSec = Math.max(1, Math.ceil((releaseAt - now) / 1000));
    return { allowed: false, retryAfterSec };
  }

  /** Регистрирует неудачу, возвращает число неудач в окне для этого логина. */
  fail(login: string): number {
    const now = this.now();
    this.prune(now);
    const key = normalizeLogin(login);
    let stamps = this.failures.get(key);
    if (stamps === undefined) {
      stamps = [];
      this.failures.set(key, stamps);
    }
    stamps.push(now);
    return stamps.length;
  }

  /** Сброс счётчика (после успешного логина). */
  reset(login: string): void {
    this.failures.delete(normalizeLogin(login));
  }

  /** Число отслеживаемых логинов (после prune). */
  size(): number {
    this.prune(this.now());
    return this.failures.size;
  }

  /** Удаляет неудачи старше окна; логины без неудач в окне убираются из Map. */
  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, stamps] of this.failures) {
      let drop = 0;
      while (drop < stamps.length && stamps[drop] <= cutoff) drop++;
      if (drop === stamps.length) {
        this.failures.delete(key);
      } else if (drop > 0) {
        stamps.splice(0, drop);
      }
    }
  }
}

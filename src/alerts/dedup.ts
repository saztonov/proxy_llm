/** In-memory cooldown: один и тот же ключ алерта не шлётся чаще, чем раз в N ms. */
export class AlertCooldown {
  private readonly lastSentAt = new Map<string, number>();

  constructor(private readonly cooldownMs: Map<string, number>) {}

  /**
   * kind — определяет длительность cooldown; instanceKey — троттлится независимо
   * (для пер-клиентских алертов, напр. `error_streak:passdesk`). По умолчанию instanceKey = kind.
   */
  shouldSend(kind: string, now: number = Date.now(), instanceKey: string = kind): boolean {
    const cooldown = this.cooldownMs.get(kind) ?? 0;
    if (cooldown === 0) return true;
    const last = this.lastSentAt.get(instanceKey);
    if (last === undefined) return true;
    return now - last >= cooldown;
  }

  markSent(kind: string, now: number = Date.now(), instanceKey: string = kind): void {
    this.lastSentAt.set(instanceKey, now);
  }
}

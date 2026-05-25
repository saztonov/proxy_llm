/** In-memory cooldown: один и тот же ключ алерта не шлётся чаще, чем раз в N ms. */
export class AlertCooldown {
  private readonly lastSentAt = new Map<string, number>();

  constructor(private readonly cooldownMs: Map<string, number>) {}

  shouldSend(key: string, now: number = Date.now()): boolean {
    const cooldown = this.cooldownMs.get(key) ?? 0;
    if (cooldown === 0) return true;
    const last = this.lastSentAt.get(key);
    if (last === undefined) return true;
    return now - last >= cooldown;
  }

  markSent(key: string, now: number = Date.now()): void {
    this.lastSentAt.set(key, now);
  }
}

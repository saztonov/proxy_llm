export interface Deadline {
  readonly startedAt: number;
  readonly deadlineAt: number;
  remaining(): number;
  hasTimeFor(ms: number): boolean;
  attemptTimeout(attemptMaxMs: number): number;
}

export function createDeadline(now: number, totalBudgetMs: number, minRemainingMs: number): Deadline {
  const deadlineAt = now + totalBudgetMs;
  return {
    startedAt: now,
    deadlineAt,
    remaining: () => deadlineAt - Date.now(),
    hasTimeFor: (ms: number) => Date.now() + ms + minRemainingMs <= deadlineAt,
    attemptTimeout: (attemptMaxMs: number) => Math.max(1, Math.min(attemptMaxMs, deadlineAt - Date.now())),
  };
}

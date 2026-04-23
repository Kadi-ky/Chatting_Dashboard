/**
 * Simple in-process circuit breaker per provider. Opens after N failures within
 * a rolling window; stays open for a cooldown; then accepts a trial call.
 */
export class CircuitBreaker {
  private failures: number[] = [];
  private openUntil: number | null = null;

  constructor(
    public readonly name: string,
    private readonly threshold: number = 5,
    private readonly windowMs: number = 60_000,
    private readonly cooldownMs: number = 120_000,
  ) {}

  canProceed(): boolean {
    if (this.openUntil === null) return true;
    if (Date.now() >= this.openUntil) {
      this.openUntil = null; // half-open: next call is the trial
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failures = [];
    this.openUntil = null;
  }

  recordFailure(): void {
    const now = Date.now();
    this.failures.push(now);
    // drop anything outside the rolling window
    this.failures = this.failures.filter((t) => now - t < this.windowMs);
    if (this.failures.length >= this.threshold) {
      this.openUntil = now + this.cooldownMs;
      this.failures = [];
    }
  }

  isOpen(): boolean {
    return this.openUntil !== null && Date.now() < this.openUntil;
  }
}

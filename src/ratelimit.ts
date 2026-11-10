export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

/** Fixed-window per-key limiter with opportunistic pruning. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  check(key: string): RateLimitResult {
    const t = this.now();
    if (this.hits.size >= this.maxKeys) this.prune(t);
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
    if (entry.count > this.max) return { allowed: false, remaining: 0, retryAfterSec };
    return { allowed: true, remaining: this.max - entry.count, retryAfterSec };
  }

  private prune(t: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
    // Still full of live keys: drop the oldest to bound memory.
    while (this.hits.size >= this.maxKeys) {
      const first = this.hits.keys().next();
      if (first.done) break;
      this.hits.delete(first.value);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}

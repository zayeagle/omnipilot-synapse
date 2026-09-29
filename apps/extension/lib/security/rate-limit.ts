/**
 * Sliding-window rate limiting.
 *
 * Scope: a compromised or runaway page can ask the extension to spend the user's provider credits
 * and GitHub quota. Limits are per tab (so one tab cannot starve another) with a global ceiling on
 * top. The clock is injected, so the windows are testable without timers.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Milliseconds until the oldest counted call leaves the window. 0 when allowed. */
  retryAfterMs: number;
  remaining: number;
  limit: number;
}

export interface RateLimitOptions {
  perKeyMax: number;
  globalMax: number;
  windowMs: number;
  now?: () => number;
}

export const AI_LIMIT = { perKeyMax: 30, globalMax: 90, windowMs: 60_000 } as const;
export const GITHUB_LIMIT = { perKeyMax: 60, globalMax: 180, windowMs: 60_000 } as const;
export const VAULT_LIMIT = { perKeyMax: 12, globalMax: 30, windowMs: 60_000 } as const;

export class SlidingWindowLimiter {
  private readonly hits: number[] = [];
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    if (max <= 0) throw new Error('rate-limit: max must be positive');
    if (windowMs <= 0) throw new Error('rate-limit: windowMs must be positive');
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Record an attempt. Rejected attempts are not counted, so the window can drain. */
  check(): RateLimitDecision {
    const at = this.now();
    this.prune(at);
    if (this.hits.length >= this.max) {
      const oldest = this.hits[0] ?? at;
      return {
        allowed: false,
        retryAfterMs: Math.max(0, oldest + this.windowMs - at),
        remaining: 0,
        limit: this.max,
      };
    }
    this.hits.push(at);
    return { allowed: true, retryAfterMs: 0, remaining: this.max - this.hits.length, limit: this.max };
  }

  private prune(at: number): void {
    const cutoff = at - this.windowMs;
    let index = 0;
    while (index < this.hits.length && (this.hits[index] as number) <= cutoff) index += 1;
    if (index > 0) this.hits.splice(0, index);
  }

  /** Undo the most recent accepted hit — used when a second gate rejects the same attempt. */
  rollbackLast(): void {
    this.hits.pop();
  }

  reset(): void {
    this.hits.length = 0;
  }
}

export class KeyedRateLimiter {
  private readonly buckets = new Map<string, SlidingWindowLimiter>();
  private readonly global: SlidingWindowLimiter;
  private readonly options: Required<Pick<RateLimitOptions, 'perKeyMax' | 'globalMax' | 'windowMs'>>;
  private readonly now: () => number;

  constructor(options: RateLimitOptions) {
    this.options = {
      perKeyMax: options.perKeyMax,
      globalMax: options.globalMax,
      windowMs: options.windowMs,
    };
    this.now = options.now ?? Date.now;
    this.global = new SlidingWindowLimiter(this.options.globalMax, this.options.windowMs, this.now);
  }

  check(key: string): RateLimitDecision {
    const bucket = this.bucketFor(key);

    // Peek the per-key bucket first; only spend global budget when the key is allowed.
    const perKey = bucket.check();
    if (!perKey.allowed) return perKey;

    const global = this.global.check();
    if (!global.allowed) {
      // Roll back the per-key hit so the user is not charged twice for one rejection.
      bucket.rollbackLast();
      return {
        allowed: false,
        retryAfterMs: global.retryAfterMs,
        remaining: perKey.remaining,
        limit: this.options.globalMax,
      };
    }
    return perKey;
  }

  private bucketFor(key: string): SlidingWindowLimiter {
    const existing = this.buckets.get(key);
    if (existing) return existing;
    const created = new SlidingWindowLimiter(this.options.perKeyMax, this.options.windowMs, this.now);
    this.buckets.set(key, created);
    return created;
  }

  reset(key?: string): void {
    if (key === undefined) {
      this.buckets.clear();
    } else {
      this.buckets.delete(key);
    }
    this.global.reset();
  }

  bucketCount(): number {
    return this.buckets.size;
  }
}

import { describe, expect, it } from 'vitest';

import { KeyedRateLimiter, SlidingWindowLimiter } from './rate-limit';

const WINDOW = 60_000;

describe('SlidingWindowLimiter (F4 UNIT)', () => {
  it('TC-F4-U05 allows the budget and rejects the call after it', () => {
    const limiter = new SlidingWindowLimiter(30, WINDOW, () => 0);
    for (let i = 0; i < 30; i += 1) {
      const decision = limiter.check();
      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(29 - i);
    }
    const rejected = limiter.check();
    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
    expect(rejected.limit).toBe(30);
    expect(rejected.retryAfterMs).toBe(WINDOW);
  });

  it('TC-F4-U05 recovers once the window has passed', () => {
    let clock = 0;
    const limiter = new SlidingWindowLimiter(3, WINDOW, () => clock);
    for (let i = 0; i < 3; i += 1) limiter.check();
    expect(limiter.check().allowed).toBe(false);

    clock = WINDOW;
    expect(limiter.check().allowed).toBe(true);
  });

  it('TC-F4-U05 slides rather than resetting in fixed buckets', () => {
    let clock = 0;
    const limiter = new SlidingWindowLimiter(2, WINDOW, () => clock);
    limiter.check();
    clock = 30_000;
    limiter.check();
    expect(limiter.check().allowed).toBe(false);

    // The first hit ages out one window after it was taken, not at a bucket boundary.
    clock = WINDOW;
    const decision = limiter.check();
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(0);
    expect(limiter.check().allowed).toBe(false);
  });

  it('TC-F4-U05 reports the wait time and rejects rejected calls from counting', () => {
    let clock = 0;
    const limiter = new SlidingWindowLimiter(1, WINDOW, () => clock);
    limiter.check();
    clock = 10_000;
    expect(limiter.check()).toMatchObject({ allowed: false, retryAfterMs: 50_000 });
    clock = 20_000;
    // Two rejections later the retry hint is unchanged: rejections never consume budget.
    expect(limiter.check()).toMatchObject({ allowed: false, retryAfterMs: 40_000 });
    clock = WINDOW;
    expect(limiter.check().allowed).toBe(true);
  });

  it('TC-F4-U05 validates its configuration and can be reset', () => {
    expect(() => new SlidingWindowLimiter(0, WINDOW)).toThrow(/max/u);
    expect(() => new SlidingWindowLimiter(1, 0)).toThrow(/windowMs/u);
    const limiter = new SlidingWindowLimiter(1, WINDOW, () => 0);
    limiter.check();
    expect(limiter.check().allowed).toBe(false);
    limiter.reset();
    expect(limiter.check().allowed).toBe(true);
  });
});

describe('KeyedRateLimiter (F4 UNIT)', () => {
  const options = { perKeyMax: 2, globalMax: 3, windowMs: WINDOW, now: () => 0 };

  it('TC-F4-U06 keeps per-tab budgets independent', () => {
    const limiter = new KeyedRateLimiter(options);
    expect(limiter.check('tab:1').allowed).toBe(true);
    expect(limiter.check('tab:1').allowed).toBe(true);
    expect(limiter.check('tab:1').allowed).toBe(false); // tab 1 exhausted
    expect(limiter.bucketCount()).toBe(1);
  });

  it('TC-F4-U06 enforces the global ceiling across tabs', () => {
    const limiter = new KeyedRateLimiter(options);
    expect(limiter.check('tab:1').allowed).toBe(true);
    expect(limiter.check('tab:2').allowed).toBe(true);
    expect(limiter.check('tab:3').allowed).toBe(true); // global budget now spent
    const rejected = limiter.check('tab:4');
    expect(rejected.allowed).toBe(false);
    expect(rejected.limit).toBe(3);
  });

  it('TC-F4-U06 does not charge the per-key bucket when the global gate rejects', () => {
    const limiter = new KeyedRateLimiter({ ...options, perKeyMax: 5, globalMax: 1 });
    expect(limiter.check('tab:1').allowed).toBe(true);
    expect(limiter.check('tab:2').allowed).toBe(false);
    // tab:2 was rolled back, so after the window it still has its full budget.
    limiter.reset('tab:1');
    expect(limiter.check('tab:2').allowed).toBe(true);
  });

  it('TC-F4-U06 resets a single bucket or everything', () => {
    const limiter = new KeyedRateLimiter(options);
    limiter.check('tab:1');
    limiter.check('tab:2');
    limiter.reset('tab:1');
    expect(limiter.check('tab:1').allowed).toBe(true);
    limiter.reset();
    expect(limiter.bucketCount()).toBe(0);
    expect(limiter.check('tab:1').allowed).toBe(true);
  });

  it('TC-F4-U06 uses a real clock by default without throwing', () => {
    const limiter = new KeyedRateLimiter({ perKeyMax: 1, globalMax: 1, windowMs: WINDOW });
    expect(limiter.check('tab:1').allowed).toBe(true);
    expect(limiter.check('tab:1').allowed).toBe(false);
  });
});

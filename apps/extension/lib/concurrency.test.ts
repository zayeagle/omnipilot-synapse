import { describe, expect, it } from 'vitest';

import { mapWithConcurrency } from './concurrency';

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('mapWithConcurrency (UNIT)', () => {
  it('never runs more than the limit at once, and returns results in input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = range(20);

    const out = await mapWithConcurrency(items, 4, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // A longer wait for the earlier items: the completion order is the reverse of the input order.
      await new Promise((resolve) => setTimeout(resolve, 20 - item));
      inFlight -= 1;
      return item * 2;
    });

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(out).toEqual(items.map((item) => item * 2));
  });

  it('treats a limit below one as one, and an empty list as no work at all', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency(range(5), 0, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return item;
    });

    expect(peak).toBe(1);
    expect(out).toEqual(range(5));
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it('rejects on the first failure instead of returning a partial list', async () => {
    const reached: number[] = [];
    await expect(
      mapWithConcurrency(range(8), 2, async (item) => {
        reached.push(item);
        if (item === 1) throw new Error('boom');
        return item;
      }),
    ).rejects.toThrow('boom');
    expect(reached).toContain(1);
  });
});

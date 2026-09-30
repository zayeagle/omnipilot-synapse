import { describe, expect, it } from 'vitest';

import { singleFlight } from './single-flight';

/**
 * TC-LC-U01 — the bootstrap race that produced an unchecked `runtime.lastError`.
 *
 * The failure it prevents is not theoretical: `onInstalled` fires while the worker is already running
 * its top-level bootstrap, and the second interleaved `removeAll()` + `create()` sequence is what made
 * Chrome log "Cannot create item with duplicate id synapse-clip-page".
 */
describe('singleFlight (worker bootstrap)', () => {
  it('TC-LC-U01 runs one task for concurrent callers, not one per caller', async () => {
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = singleFlight(async () => {
      started += 1;
      await gate;
    });

    const first = task();
    const second = task();
    // The task starts on a microtask (that is what turns a synchronous throw into a rejection), so a
    // tick is needed before it is observable.
    await Promise.resolve();
    expect(started).toBe(1);
    expect(second).toBe(first);

    release();
    await first;
    await second;
    expect(started).toBe(1);
  });

  it('TC-LC-U02 boots again once the previous run has settled', async () => {
    let started = 0;
    const task = singleFlight(() => {
      started += 1;
    });

    await task();
    await task();
    // A recycled worker must be able to register its menus again.
    expect(started).toBe(2);
  });

  it('TC-LC-U03 clears the slot when the task rejects, so a retry is possible', async () => {
    let attempts = 0;
    const task = singleFlight(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('boom');
    });

    await expect(task()).rejects.toThrow('boom');
    expect(attempts).toBe(1);
    // A wedged slot would make every later boot a no-op; this is the assertion that keeps it honest.
    await expect(task()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});

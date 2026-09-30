/**
 * Run an async task at most once at a time.
 *
 * The worker's bootstrap is reachable from three places — `runtime.onInstalled`, `runtime.onStartup`
 * and the module's own top-level call — and Chrome fires the first two while the worker is already
 * evaluating, so two boots really do overlap. That is not harmless: registration is `removeAll()`
 * followed by `create()`, and two interleaved sequences make the second `create` fail with
 * "Cannot create item with duplicate id", which Chrome then reports on the extensions page.
 *
 * Concurrent callers share the run that is already in flight. Once it settles the slot is cleared, so
 * the next call starts a fresh run — a recycled worker must be able to boot again.
 */
export function singleFlight(task: () => Promise<void> | void): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) return inFlight;
    // `Promise.resolve().then(task)` also turns a synchronous throw into a rejection, so a failure
    // always clears the slot through the same path instead of wedging it.
    const run = Promise.resolve()
      .then(task)
      .finally(() => {
        if (inFlight === run) inFlight = null;
      });
    inFlight = run;
    return run;
  };
}

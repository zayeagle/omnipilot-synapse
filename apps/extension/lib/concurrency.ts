/**
 * Run an async worker over a list with a ceiling on how many run at once.
 *
 * Written here rather than pulled in: this repository takes no new runtime dependency, and all three
 * properties below are what the callers actually need — a fixed ceiling, results in input order, and
 * fail-fast (the first rejection rejects the whole call, because a half-read batch is not a result and
 * silently dropping the failures would hide them).
 */

/** Map over \`items\` with at most \`limit\` workers in flight. Results keep the input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  // A ceiling below one would deadlock the loop below; one is the smallest useful pool.
  const ceiling = Math.max(1, Math.floor(limit));
  let cursor = 0;

  const run = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  };

  // \`Promise.all\` subscribes to every runner, so a rejection after the first is handled (ignored)
  // rather than surfacing as an unhandled rejection.
  await Promise.all(
    Array.from({ length: Math.min(ceiling, items.length) }, () => run()),
  );
  return results;
}

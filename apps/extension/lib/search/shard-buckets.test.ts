import { describe, expect, it } from 'vitest';

import { EMPTY_TERM_SHARD_KEY, SHARD_BUCKETS, isShardKey, shardKey } from './tokenize';

/**
 * F16 - the bucket scheme is bounded, deterministic, and its generation is identifiable.
 *
 * The last point is the one that bites: 256 and 64 buckets both produce three-character keys, so without a
 * generation letter an older shard would look live and the index would answer for the wrong terms.
 */
describe('shard buckets (F16 UNIT)', () => {
  it('TC-F16-U03 bounds the buckets and marks its generation', () => {
    expect(SHARD_BUCKETS).toBe(64);

    const terms = ['能', '力', '能力', 'spaced', 'repetition', 'x', '能力可以提升信任'];
    const keys = new Set(terms.map((term) => shardKey(term)));
    expect(keys.size).toBeLessThanOrEqual(SHARD_BUCKETS);
    for (const key of keys) expect(isShardKey(key)).toBe(true);
    for (const key of keys) expect(key.startsWith('c')).toBe(true);

    // Deterministic: the same term always lands in the same bucket.
    expect(shardKey('能力')).toBe(shardKey('能力'));
    // The 256-bucket generation is residue, not a live key.
    expect(isShardKey('b0f')).toBe(false);
    expect(isShardKey('bff')).toBe(false);
    expect(isShardKey(EMPTY_TERM_SHARD_KEY)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import { shouldUseLocalIndex } from './local-store';

/**
 * F16 step 4 - the two ways a machine's index must NOT be trusted.
 *
 * Nothing built here yet, or built from a head the repository has moved past: answering from either would serve
 * something other than what the records now say, and quietly. A head that is simply unknown cannot make the
 * index stale, so the index is trusted then.
 */
describe('local index decision (F16 UNIT)', () => {
  it('TC-F16-U07 refuses an index with nothing in it, or one built for another head', () => {
    // Nothing built on this machine.
    expect(shouldUseLocalIndex({ shards: 0, builtForHead: null, repoHead: 'h1' })).toBe(false);
    // Built here, and the repository is at the head it was built from.
    expect(shouldUseLocalIndex({ shards: 3, builtForHead: 'h1', repoHead: 'h1' })).toBe(true);
    // The repository moved on: the index describes the past.
    expect(shouldUseLocalIndex({ shards: 3, builtForHead: 'h0', repoHead: 'h1' })).toBe(false);
    // Never recorded (an index from before this existed), with a known head: not this head, so not trusted.
    expect(shouldUseLocalIndex({ shards: 3, builtForHead: null, repoHead: 'h1' })).toBe(false);
    // No head to compare against: nothing can make it stale.
    expect(shouldUseLocalIndex({ shards: 3, builtForHead: 'h0', repoHead: null })).toBe(true);
  });
});

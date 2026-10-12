import { describe, expect, it } from 'vitest';

import { shouldUseLocalIndex, signatureOf } from './local-store';

/**
 * F16 step 4 - the index is usable only for the records it was built from.
 *
 * The signature is over the cache the two sides share, so nothing races: a record set that changed makes the
 * signature differ, and an index with no signature recorded is never treated as current.
 */
describe('local index decision (F16 UNIT)', () => {
  it('TC-F16-U07 refuses an index with nothing in it, or one built from other records', () => {
    expect(shouldUseLocalIndex({ shards: 0, builtFrom: 'a', current: 'a' })).toBe(false);
    expect(shouldUseLocalIndex({ shards: 3, builtFrom: 'a', current: 'a' })).toBe(true);
    expect(shouldUseLocalIndex({ shards: 3, builtFrom: 'a', current: 'b' })).toBe(false);
    expect(shouldUseLocalIndex({ shards: 3, builtFrom: null, current: 'a' })).toBe(false);
    expect(shouldUseLocalIndex({ shards: 3, builtFrom: 'a', current: null })).toBe(false);
  });

  it('TC-F16-U08 signs the record set, order-independently and content-sensitively', () => {
    expect(signatureOf(['a:1', 'b:2'])).toBe(signatureOf(['b:2', 'a:1']));
    expect(signatureOf(['a:1', 'b:2'])).not.toBe(signatureOf(['a:1', 'b:3']));
    expect(signatureOf(['a:1'])).not.toBe(signatureOf(['a:1', 'b:2']));
  });
});

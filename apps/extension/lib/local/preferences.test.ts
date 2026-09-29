import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_PREFERENCES,
  REFUSAL_LIMIT,
  acceptSuggestion,
  isSuppressed,
  normalizePreferences,
  preferredTopic,
  recordCorrection,
  recordRefusal,
  suggestionKey,
} from './preferences';

/**
 * TC-P9-U03/U06 — the memory that makes a suggestion tolerable.
 *
 * Three properties are asserted, and the third is the one a reviewer would otherwise have to take on trust: that
 * refusing twice silences a suggestion, that a correction becomes the user's own rule, and that **none of this can
 * reach the repository** — the module has no imports at all, so there is no path by which a private preference
 * could travel to a host.
 */
describe('local preferences (E4/E5 UNIT)', () => {
  it('TC-P9-U03 refuses twice, then stops suggesting', () => {
    const key = suggestionKey({ kind: 'link', from: 'a', to: 'b' });
    const once = recordRefusal(EMPTY_PREFERENCES, key);
    expect(isSuppressed(once, key)).toBe(false);

    const twice = recordRefusal(once, key);
    expect(isSuppressed(twice, key)).toBe(true);
    expect(REFUSAL_LIMIT).toBe(2);

    // Accepting is the strongest signal: it erases the refusals.
    expect(isSuppressed(acceptSuggestion(twice, key), key)).toBe(false);
    // Accepting something never refused changes nothing.
    expect(acceptSuggestion(EMPTY_PREFERENCES, 'unknown')).toBe(EMPTY_PREFERENCES);
  });

  it('TC-P9-U06 a correction becomes the rule for those terms', () => {
    const learned = recordCorrection(EMPTY_PREFERENCES, ['Memory', 'spacing'], 't-memory');
    // The user's own choice now answers for the terms they corrected…
    expect(preferredTopic(learned, ['memory', 'spacing'])).toEqual({
      topicId: 't-memory',
      matchedTerms: ['memory', 'spacing'],
    });
    // …and silence is still the answer for anything they have never decided about.
    expect(preferredTopic(learned, ['gardening'])).toBeNull();
    // A tie between two of the user's own habits is still not advice…
    const split = recordCorrection(recordCorrection(EMPTY_PREFERENCES, ['a'], 't1'), ['b'], 't2');
    expect(preferredTopic(split, ['a', 'b'])).toBeNull();
    // …while the *latest* correction for the same term is decisive: the user changed their mind, and that is
    // the strongest evidence there is, not a conflict to be balanced.
    const changed = recordCorrection(recordCorrection(EMPTY_PREFERENCES, ['mixed'], 't1'), ['mixed'], 't2');
    expect(preferredTopic(changed, ['mixed'])).toEqual({ topicId: 't2', matchedTerms: ['mixed'] });
  });

  it('TC-P9-U03 junk is dropped, not trusted', () => {
    expect(normalizePreferences('nonsense')).toEqual(EMPTY_PREFERENCES);
    const cleaned = normalizePreferences({
      refused: { a: 2, b: -1, c: 'lots', d: 1.7 },
      topicAffinity: { memory: 't1', '': 't2', empty: '' },
    });
    expect(cleaned.refused).toEqual({ a: 2, d: 1 });
    expect(cleaned.topicAffinity).toEqual({ memory: 't1' });
  });

  it('TC-P9-I01 this module cannot reach the repository: it imports nothing at all', () => {
    const source = readFileSync(fileURLToPath(new URL('./preferences.ts', import.meta.url)), 'utf8');
    const imports = source.match(/^\s*import\s.+$/gmu) ?? [];
    // No storage, no store, no sync, no message layer — so a private preference has nowhere to travel.
    expect(imports).toEqual([]);
  });
});

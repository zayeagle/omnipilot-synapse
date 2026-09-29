/**
 * What the product learns about the user — and the two criteria that were missing entirely (E4, E5).
 *
 * The audit called this out as the biggest gap against the philosophy: the product made suggestions and then
 * forgot being turned down, and it could be corrected without ever remembering the correction. A collaborator who
 * repeats a rejected idea is not a collaborator; a collaborator who re-learns nothing from your edits is a nuisance.
 *
 * Two hard rules live here:
 * - **This never goes to the repository.** Preferences are a picture of how someone thinks; the repository is
 *   shared with a host, and may be public. They are stored in `storage.local` and nowhere else — the module
 *   imports nothing at all, so there is no code path by which they could travel.
 * - **Learning is explicit and reversible.** Refusals are counted (two silence the suggestion); accepting clears
 *   the count; corrections are keyed by the terms they were made about, so the next similar item matches the
 *   user's own classification instead of the model's guess.
 */

export interface LocalPreferences {
  /** suggestion key → how many times it was refused. */
  refused: Record<string, number>;
  /** lower-cased term → the topic id the user themselves chose for it. */
  topicAffinity: Record<string, string>;
}

export const EMPTY_PREFERENCES: LocalPreferences = { refused: {}, topicAffinity: {} };

/** Two refusals are enough: one could be a mis-tap, three means we kept nagging. */
export const REFUSAL_LIMIT = 2;

/** Tolerant read: junk is dropped rather than trusted, and never throws. */
export function normalizePreferences(value: unknown): LocalPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ...EMPTY_PREFERENCES };
  const raw = value as Record<string, unknown>;
  const refused: Record<string, number> = {};
  const refusedRaw = raw['refused'];
  if (typeof refusedRaw === 'object' && refusedRaw !== null && !Array.isArray(refusedRaw)) {
    for (const [key, count] of Object.entries(refusedRaw as Record<string, unknown>)) {
      if (typeof count === 'number' && Number.isFinite(count) && count > 0) refused[key] = Math.floor(count);
    }
  }
  const topicAffinity: Record<string, string> = {};
  const affinityRaw = raw['topicAffinity'];
  if (typeof affinityRaw === 'object' && affinityRaw !== null && !Array.isArray(affinityRaw)) {
    for (const [term, topicId] of Object.entries(affinityRaw as Record<string, unknown>)) {
      if (term.length > 0 && typeof topicId === 'string' && topicId.length > 0) topicAffinity[term] = topicId;
    }
  }
  return { refused, topicAffinity };
}

/** A stable identity for one suggestion, so the same one can be recognised later. */
export function suggestionKey(parts: { kind: string; from: string; to: string }): string {
  return parts.kind + '|' + parts.from + '|' + parts.to;
}

export function isSuppressed(preferences: LocalPreferences, key: string): boolean {
  return (preferences.refused[key] ?? 0) >= REFUSAL_LIMIT;
}

export function recordRefusal(preferences: LocalPreferences, key: string): LocalPreferences {
  const refused = { ...preferences.refused, [key]: (preferences.refused[key] ?? 0) + 1 };
  return { ...preferences, refused };
}

/** Accepting is the strongest signal there is: it erases the refusals for that suggestion. */
export function acceptSuggestion(preferences: LocalPreferences, key: string): LocalPreferences {
  if (preferences.refused[key] === undefined) return preferences;
  const refused = { ...preferences.refused };
  delete refused[key];
  return { ...preferences, refused };
}

/**
 * Remember what the user did, not what the model said (E5).
 *
 * Keyed by the terms the decision was *about*, so a later item sharing those terms is matched against the user's
 * own choice — and the later model suggestion never gets a second chance to be wrong about the same thing.
 */
export function recordCorrection(
  preferences: LocalPreferences,
  terms: readonly string[],
  topicId: string,
): LocalPreferences {
  if (topicId.length === 0) return preferences;
  const topicAffinity = { ...preferences.topicAffinity };
  for (const term of terms) {
    const key = term.trim().toLowerCase();
    if (key.length > 0) topicAffinity[key] = topicId;
  }
  return { ...preferences, topicAffinity };
}

/** The topic the user's own past decisions point at, or null when they have never decided about these terms. */
export function preferredTopic(
  preferences: LocalPreferences,
  terms: readonly string[],
): { topicId: string; matchedTerms: readonly string[] } | null {
  const votes = new Map<string, string[]>();
  for (const term of terms) {
    const key = term.trim().toLowerCase();
    const topicId = preferences.topicAffinity[key];
    if (topicId === undefined) continue;
    votes.set(topicId, [...(votes.get(topicId) ?? []), key]);
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1].length - a[1].length);
  const first = ranked[0];
  if (first === undefined) return null;
  // A tie between two of the user's own habits is still not advice.
  if (ranked[1] !== undefined && ranked[1][1].length === first[1].length) return null;
  return { topicId: first[0], matchedTerms: first[1] };
}

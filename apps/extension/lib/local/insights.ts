/**
 * Local intelligence: the suggestions this product makes without asking anyone else (F7 / G10).
 *
 * Three rules shape everything here, and they come straight from the criteria:
 * 1. **Local only.** No network, no model. Every answer is computed from what is already on this device, so the
 *    suggestions cost nothing, leak nothing, and work on a plane.
 * 2. **Every suggestion carries its reason.** A recommendation a user cannot interrogate is a recommendation they
 *    will learn to ignore (E3); `reason` is a field, not a nicety.
 * 3. **Silence beats a guess.** When the evidence is weak or tied, these functions return `null` — showing nothing
 *    is a legitimate, deliberate outcome, not a failure to have an opinion.
 *
 * Structural inputs, not the full CKF records: this module only needs a few fields, and asking for exactly those
 * keeps it decoupled from the storage layer (and trivially testable).
 */

export interface InsightDocument {
  id: string;
  path: string;
  title: string;
  tags: readonly string[];
  /** Lower-cased terms, already tokenized by the caller's tokenizer. */
  terms: readonly string[];
  url?: string;
  /** The same content fingerprint the dedup layer uses, when the caller has one. */
  contentKey?: string;
}

export interface RecallCandidate {
  id: string;
  path: string;
  title: string;
  reason: 'same-url' | 'same-content' | 'shared-tags' | 'shared-terms';
  /** How strong the overlap is — the caller may use it to order, never to hide the reason. */
  score: number;
}

/**
 * "You have saved something like this before."
 *
 * Ordered by evidence strength: an identical canonical URL is not a hint, it is the same page; a shared content
 * fingerprint is the same text from elsewhere; tags and terms are progressively weaker. Only the best reason is
 * reported per document, so the user is told *why* rather than being handed a pile of overlapping justifications.
 */
export function recallHint(
  incoming: { url?: string; contentKey?: string; tags?: readonly string[]; terms?: readonly string[] },
  documents: readonly InsightDocument[],
  options: { minSharedTags?: number; minSharedTerms?: number } = {},
): RecallCandidate | null {
  const minTags = options.minSharedTags ?? 1;
  const minTerms = options.minSharedTerms ?? 3;
  const tags = new Set((incoming.tags ?? []).map((tag) => tag.toLowerCase()));
  const terms = new Set((incoming.terms ?? []).map((term) => term.toLowerCase()));

  let best: RecallCandidate | null = null;
  for (const document of documents) {
    let candidate: RecallCandidate | null = null;
    if (incoming.url !== undefined && incoming.url.length > 0 && document.url === incoming.url) {
      candidate = { id: document.id, path: document.path, title: document.title, reason: 'same-url', score: 1 };
    } else if (
      incoming.contentKey !== undefined &&
      incoming.contentKey.length > 0 &&
      document.contentKey === incoming.contentKey
    ) {
      candidate = { id: document.id, path: document.path, title: document.title, reason: 'same-content', score: 0.9 };
    } else {
      const sharedTags = document.tags.filter((tag) => tags.has(tag.toLowerCase())).length;
      if (sharedTags >= minTags) {
        candidate = {
          id: document.id,
          path: document.path,
          title: document.title,
          reason: 'shared-tags',
          score: 0.5 + Math.min(0.3, sharedTags / 10),
        };
      } else {
        const sharedTerms = document.terms.filter((term) => terms.has(term.toLowerCase())).length;
        if (sharedTerms >= minTerms) {
          candidate = {
            id: document.id,
            path: document.path,
            title: document.title,
            reason: 'shared-terms',
            score: 0.2 + Math.min(0.2, sharedTerms / 50),
          };
        }
      }
    }
    if (candidate !== null && (best === null || candidate.score > best.score)) best = candidate;
  }
  return best;
}

export interface TopicCandidate {
  id: string;
  name: string;
  /** Terms the decision was based on — shown to the user, so the suggestion is checkable. */
  matchedTerms: readonly string[];
  score: number;
}

/**
 * "This note might belong under …"
 *
 * Two refusals are deliberate: below the threshold, and on a tie between two topics with the same score. Either
 * would be a coin flip dressed as advice, and a user who catches the system doing that stops trusting the ones it
 * gets right.
 */
export function suggestTopic(
  record: { terms: readonly string[] },
  topics: ReadonlyArray<{ id: string; name: string; terms: readonly string[] }>,
  options: { minScore?: number } = {},
): TopicCandidate | null {
  const minScore = options.minScore ?? 2;
  const recordTerms = new Set(record.terms.map((term) => term.toLowerCase()));
  const scored = topics.map((topic) => {
    const matched = topic.terms.filter((term) => recordTerms.has(term.toLowerCase()));
    return { id: topic.id, name: topic.name, matchedTerms: matched, score: matched.length };
  });
  const ranked = scored.filter((entry) => entry.score >= minScore).sort((a, b) => b.score - a.score);
  const first = ranked[0];
  if (first === undefined) return null;
  // A tie is not a recommendation: return nothing rather than pick arbitrarily.
  if (ranked[1] !== undefined && ranked[1].score === first.score) return null;
  return first;
}

/**
 * The slice of a real @@ReviewState@@ this needs.
 *
 * Deliberately the *actual* shape (`next_review_at` / `stability` / `retrievability`) rather than a convenient
 * one: a queue computed from fields the stored record does not have would be a second, silently diverging
 * definition of "due".
 */
export interface ReviewInput {
  id: string;
  path: string;
  title: string;
  /** ISO timestamp, or null when the entry has never been scheduled (a card accepted just now). */
  next_review_at: string | null;
  stability?: number;
  retrievability?: number;
  use_count?: number;
}

export interface DueItem extends ReviewInput {
  dueAt: number;
  /** Negative when overdue — the UI can say "3 天前该复习". */
  overdueMs: number;
}

/**
 * "These are the notes you are about to forget."
 *
 * Due = the timestamp the record itself carries; an entry with no schedule (just accepted) or an unparseable
 * one is due **now** rather than silently dropped — the same rule as @@never reviewed ⇒ due immediately@@.
 * Sorted most-overdue first, so a truncating UI drops the least urgent.
 */
/**
 * Read `review/state.json` into the slice the queue needs.
 *
 * Tolerant on purpose, and the same rule as every other reader in this codebase: a foreign or half-written entry
 * is dropped rather than trusted, and an unreadable file yields an empty queue instead of an exception — a corrupt
 * schedule must never make the surface look broken. Both shapes are accepted (the canonical
 * `{ schema, items }` written by the accept path, and a bare id→record map) because nothing enforced the
 * container before this requirement defined it.
 */
export function parseReviewFile(raw: string | null): ReviewRecord[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  const nested = record['items'];
  const container =
    typeof nested === 'object' && nested !== null && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : record;
  const out: ReviewRecord[] = [];
  for (const [key, value] of Object.entries(container)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (entry['kind'] !== 'review') continue;
    const id = typeof entry['id'] === 'string' && entry['id'].length > 0 ? entry['id'] : key;
    if (id.length === 0) continue;
    out.push({
      id,
      next_review_at: typeof entry['next_review_at'] === 'string' ? entry['next_review_at'] : null,
      ...(typeof entry['stability'] === 'number' ? { stability: entry['stability'] } : {}),
      ...(typeof entry['retrievability'] === 'number' ? { retrievability: entry['retrievability'] } : {}),
      ...(typeof entry['use_count'] === 'number' ? { use_count: entry['use_count'] } : {}),
    });
  }
  return out;
}

/** A stored review entry, before it is joined with the index for a human-readable label. */
export interface ReviewRecord {
  id: string;
  next_review_at: string | null;
  stability?: number;
  retrievability?: number;
  use_count?: number;
}

export function dueForReview(states: readonly ReviewInput[], now: number): DueItem[] {
  return states
    .map((state) => {
      const parsed = state.next_review_at === null ? Number.NaN : Date.parse(state.next_review_at);
      const dueAt = Number.isNaN(parsed) ? now : parsed;
      return { ...state, dueAt, overdueMs: now - dueAt };
    })
    .filter((entry) => entry.overdueMs >= 0)
    .sort((a, b) => b.overdueMs - a.overdueMs);
}

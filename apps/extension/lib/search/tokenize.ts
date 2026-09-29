/**
 * Search tokenization — the one place that decides what a document (and a query) is made of.
 *
 * PURE MODULE: no browser, DOM, network or clock access, so the whole retrieval layer can be
 * exercised in Node.
 *
 * Reuses the F1 `core/dedup.ts` rules verbatim (latin per word, CJK per character) and adds **CJK
 * bigrams** on top. The single characters keep recall — a two-character query still finds a document
 * that only shares one character — while the bigrams add precision: a query for `间隔` expands to
 * `间`, `隔` and `间隔`, so a document that actually contains the word scores 3/3 where a document
 * that merely contains both characters apart scores 2/3. That difference is what TC-F4-U07 pins
 * down.
 */

import { tokenize } from '../core/dedup';

/** CJK scripts whose writing system has no inter-word spaces, so word tokens must be built here. */
const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Shard keys are the first two code points of a term: `search/间隔.json`, `search/al.json`. */
export const SHARD_KEY_LENGTH = 2;

/**
 * Shard key for a term that has no code points at all (an empty or whitespace-only string).
 *
 * `_` can never collide with a real key: `tokenize()` only ever emits `\p{L}`, `\p{N}` and CJK
 * characters, so no index term can contain an underscore.
 */
export const EMPTY_TERM_SHARD_KEY = '_';

/** True when a single token is one CJK character (i.e. eligible for bigram formation). */
export function isCjkToken(token: string): boolean {
  return token.length > 0 && CJK_CHARACTER.test(token);
}

/**
 * Tokenize text for the search index: the `core/dedup.ts` tokens plus adjacent CJK bigrams,
 * lowercased and de-duplicated per document.
 *
 * De-duplication is per *document* (and per query), not per term list: `addRecord` folds a repeated
 * token into `tf` rather than writing the same posting twice. Order is first-appearance order, so
 * the output is a deterministic function of the input.
 */
export function tokenizeForSearch(text: string): string[] {
  const base = tokenize(text);
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (term: string): void => {
    const folded = term.toLowerCase();
    if (folded.length === 0 || seen.has(folded)) return;
    seen.add(folded);
    out.push(folded);
  };

  for (const token of base) push(token);
  for (let i = 0; i + 1 < base.length; i += 1) {
    const left = base[i];
    const right = base[i + 1];
    if (left === undefined || right === undefined) continue;
    if (isCjkToken(left) && isCjkToken(right)) push(left + right);
  }
  return out;
}

/**
 * Shard key of a term: its first {@link SHARD_KEY_LENGTH} code points.
 *
 * `Array.from` iterates by code point, not by UTF-16 code unit, so a term that starts with a
 * surrogate pair (a rare CJK extension character, an emoji in a tag) yields one character rather
 * than half of one — a lone surrogate is not a legal file name on every platform.
 *
 * Fallback for a 1-character term: the character itself (`search/间.json`). That is still a valid,
 * stable, collision-free key — the two-character rule is a *bucketing* choice, not a requirement
 * that the key be two characters long. A term with no code points at all falls back to
 * {@link EMPTY_TERM_SHARD_KEY}, which no real term can produce.
 */
export function shardKey(term: string): string {
  const characters = Array.from(term.trim().toLowerCase());
  if (characters.length === 0) return EMPTY_TERM_SHARD_KEY;
  return characters.slice(0, SHARD_KEY_LENGTH).join('');
}

/**
 * Code-point comparison.
 *
 * Deliberately *not* `localeCompare`: shard files and `NOTES.md` are committed, so their order has to
 * be identical on every machine and in every CI container, and `localeCompare` depends on the ICU
 * locale data that happens to be installed.
 */
export function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

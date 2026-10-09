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

import { stableHash32, tokenize } from '../core/dedup';

/** CJK scripts whose writing system has no inter-word spaces, so word tokens must be built here. */
const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/**
 * How many buckets the vocabulary is split across.
 *
 * A shard key used to be a term's first two code points, which makes the number of shards a function of
 * the *vocabulary*: Latin gives a few hundred, and CJK gives thousands, because
 * {@link tokenizeForSearch} emits both the single characters and the adjacent bigrams. One 681-character
 * page touched 900 shards, so its commit — the record, the manifest and every shard it touched — blew
 * past `MAX_COMMIT_FILES` and was refused outright, and anything long enough to fit still waited on
 * hundreds of uploads.
 *
 * A bucket count replaces "one shard per prefix" with "one shard per bucket": one capture rewrites at
 * most this many files plus two, whatever the page is written in. It trades per-file size against
 * per-capture requests — 256 keeps a shard in the same range the prefix scheme already produced for
 * Latin, while capping a capture's commit at 258 files.
 *
 * Changing this number renames every shard, so it needs `search.rebuild` (the options page has the
 * button); {@link isShardKey} is what tells a stale shard from a live one in the meantime.
 */
export const SHARD_BUCKETS = 256;

/** A bucket key lives in its own space — `b` + the bucket index in hex — so it can never be mistaken for
 * one of the two-character prefix keys this scheme replaced. */
const BUCKET_PREFIX = 'b';
const BUCKET_WIDTH = (SHARD_BUCKETS - 1).toString(16).length;

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
 * Shard key of a term: the bucket it hashes into, `b00`…`bff` for {@link SHARD_BUCKETS} = 256.
 *
 * Folded first, so the key agrees with the term {@link tokenizeForSearch} emitted and two spellings of
 * one term cannot land in different files. The hash covers the *whole* term rather than a prefix, which
 * is what makes the number of shards independent of how large the vocabulary grows.
 *
 * A term with no characters keeps {@link EMPTY_TERM_SHARD_KEY} instead of a bucket: `tokenize()` never
 * emits an underscore, so the sentinel can never collide with a bucket name.
 */
export function shardKey(term: string): string {
  const folded = term.trim().toLowerCase();
  if (folded.length === 0) return EMPTY_TERM_SHARD_KEY;
  const bucket = stableHash32(folded) % SHARD_BUCKETS;
  return BUCKET_PREFIX + bucket.toString(16).padStart(BUCKET_WIDTH, '0');
}

/**
 * True when `key` is a bucket this version writes.
 *
 * The index lives in the repository, so a shard written by an older version is still sitting there after
 * an update. Those keys are valid JSON under a valid path — nothing about them is corrupt — so without
 * this check a stale index would answer queries with *silently* missing postings. Recognising the key
 * space turns that into the visible, actionable "rebuild the index" state the UI already offers.
 */
export function isShardKey(key: string): boolean {
  if (key === EMPTY_TERM_SHARD_KEY) return true;
  if (key.length !== BUCKET_PREFIX.length + BUCKET_WIDTH) return false;
  if (!key.startsWith(BUCKET_PREFIX)) return false;
  return /^[0-9a-f]+$/u.test(key.slice(BUCKET_PREFIX.length));
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

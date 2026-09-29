/**
 * Postings model — the inverted index, one `search/<key>.json` shard at a time.
 *
 * PURE MODULE: no browser, DOM, network or clock access. Every function is a deterministic
 * function of its arguments, which is what makes an incremental shard write reproducible and a
 * repository rewrite diff-free.
 *
 * Why shards: a capture touches only the shards its own terms hash to (a handful), so pushing a note
 * rewrites a few kilobytes instead of the whole index (04-design F4 step 1, TC-F4-I02). Shards are
 * always rebuildable from the notes, so a lost or corrupt shard is a rebuild, never data loss
 * (SC-F6-03).
 *
 * Immutability: `addRecord`/`removeRecord` return a new shard. Only the term lists they actually
 * touch are copied, so adding one capture to a 5 000-posting list is O(touched), not O(index).
 */

import { type CkfRecord } from '../core/ckf';
import { joinPath, normalizePrefix } from '../core/paths';
import { compareText, shardKey, tokenizeForSearch } from './tokenize';

export const POSTINGS_SCHEMA_VERSION = 1;

export const SHARD_DIR = 'search';

/**
 * Upper bound on one term's posting list inside one shard.
 *
 * A term that appears in every record (a stop word, a ubiquitous tag) would otherwise turn one
 * shard into a multi-megabyte file that every single capture rewrites. Beyond the cap the list stops
 * growing but is **never silently truncated**: a {@link TruncationMarker} records how many postings
 * were dropped, so a query that misses a very common term can tell why. Rebuild from the notes at
 * any time with a higher cap if a corpus ever needs it. TC-F4-U04 pins this down.
 *
 * 4096 (a power of two) keeps a shard in the low hundreds of kilobytes even for a pathological term,
 * and is reached well before the 5 000/10 000-record corpora the test plan describes.
 */
export const MAX_POSTINGS_PER_TERM = 4096;

/**
 * The indexed fields, in the fixed order used everywhere a stable sort is needed.
 *
 * `body` is last on purpose: it is the only field whose text can be arbitrarily long, so it is the
 * one that is cheap to store and expensive to score.
 */
export const FIELD_ORDER = ['title', 'summary', 'point', 'body', 'tag', 'topic'] as const;

export type SearchField = (typeof FIELD_ORDER)[number];

/**
 * Field weights (04-design F4 step 2): title 5 > tag 4 > summary/point 3 > topic 2 > body 1.
 *
 * `summary` and `point` share a weight: both are distilled prose, and the design ranks them
 * together.
 */
export const FIELD_WEIGHTS: Record<SearchField, number> = {
  title: 5,
  tag: 4,
  summary: 3,
  point: 3,
  body: 1,
  topic: 2,
};

/** One record's contribution to one term, for one field. Unique per `(id, field)` within a term. */
export interface Posting {
  id: string;
  path: string;
  field: SearchField;
  tf: number;
}

/**
 * Explicit truncation marker.
 *
 * `MAX_POSTINGS_PER_TERM` is a hard cap, so the posting that would have exceeded it is not stored —
 * but the cap is *visible* in the shard instead of the loss being silent. The marker is always the
 * last entry of a list (postings stay sorted in front of it).
 */
export interface TruncationMarker {
  truncated: true;
  /** How many postings this term has dropped so far. */
  dropped: number;
}

/** A term's list: sorted postings, optionally followed by one truncation marker. */
export type PostingList = Array<Posting | TruncationMarker>;

/**
 * One shard file, `search/<shardKey>.json`.
 *
 * `terms` is keyed by the *term itself*, not by its shard key, so a shard remains readable and
 * greppable without knowing the bucketing rule.
 */
export interface PostingsShard {
  schema: typeof POSTINGS_SCHEMA_VERSION;
  terms: Record<string, PostingList>;
}

/**
 * The subset of a knowledge record the index needs, with its repository path already resolved.
 *
 * `fields` holds the raw field texts (`points` and `tags` are arrays, hence the list). A field that
 * is absent or empty is simply not indexed.
 */
export interface SearchDocument {
  id: string;
  kind: CkfRecord['kind'];
  path: string;
  title: string;
  fields: Partial<Record<SearchField, readonly string[]>>;
  /** ISO timestamp used for recency decay; `''` when the record carries none. */
  updated_at: string;
}

/** One `(term, posting)` pair produced by a document. */
export interface TermPosting {
  term: string;
  posting: Posting;
}

/* ------------------------------------------------------------------ *
 * Deterministic ordering
 * ------------------------------------------------------------------ */

function fieldRank(field: SearchField): number {
  const rank = FIELD_ORDER.indexOf(field);
  return rank < 0 ? FIELD_ORDER.length : rank;
}

/** Postings are ordered by record id, then by field order. */
function comparePostings(a: Posting, b: Posting): number {
  if (a.id !== b.id) return compareText(a.id, b.id);
  return fieldRank(a.field) - fieldRank(b.field);
}

/** Truncation markers sort after every posting, so the marker stays the last entry. */
function compareListEntries(a: Posting | TruncationMarker, b: Posting | TruncationMarker): number {
  const left = isTruncationMarker(a);
  const right = isTruncationMarker(b);
  if (left && right) return 0;
  if (left) return 1;
  if (right) return -1;
  return comparePostings(a, b);
}

/* ------------------------------------------------------------------ *
 * Records → documents → postings
 * ------------------------------------------------------------------ */

function compact(texts: ReadonlyArray<string | undefined>): string[] {
  return texts.filter((text): text is string => typeof text === 'string' && text.trim() !== '');
}

/**
 * Project a CKF record onto the index's document shape.
 *
 * `path` is passed in rather than derived: the index owns path derivation (`SearchIndex`), and a
 * vault-mode path is opaque, so the two must not be able to disagree.
 *
 * A card's `scenarios`/`counter_examples` are indexed under `body` — they are secondary prose, and
 * the field list is fixed by the design.
 */
export function documentOf(record: CkfRecord, path: string): SearchDocument {
  switch (record.kind) {
    case 'source':
      return {
        id: record.id,
        kind: 'source',
        path,
        title: record.title,
        fields: {
          title: compact([record.title]),
          body: compact([record.body]),
          tag: compact(record.tags),
        },
        updated_at: record.captured_at,
      };
    case 'card':
      return {
        id: record.id,
        kind: 'card',
        path,
        title: record.title,
        fields: {
          title: compact([record.title]),
          summary: compact([record.summary]),
          point: compact(record.points),
          body: compact([...(record.scenarios ?? []), ...(record.counter_examples ?? [])]),
          tag: compact(record.tags),
          topic: compact([record.topic_id]),
        },
        updated_at: record.distilled_by?.at ?? '',
      };
    case 'topic':
      return {
        id: record.id,
        kind: 'topic',
        path,
        title: record.name,
        fields: {
          title: compact([record.name]),
          topic: compact([record.name]),
        },
        updated_at: '',
      };
    case 'review':
      // Review state is pure scheduling metadata: there is nothing to retrieve from it.
      return { id: record.id, kind: 'review', path, title: '', fields: {}, updated_at: '' };
  }
}

/**
 * Every posting a document contributes, in deterministic order (field order, then term).
 *
 * `tf` counts the field's texts that contain the term (a repeated term in one point counts once, a
 * term present in two points counts twice). The token stream itself is de-duplicated per document by
 * `tokenizeForSearch`, so this is the only place multiplicity is measured.
 */
export function termPostings(document: SearchDocument): TermPosting[] {
  const out: TermPosting[] = [];
  for (const field of FIELD_ORDER) {
    const texts = document.fields[field];
    if (!texts || texts.length === 0) continue;
    const counts = new Map<string, number>();
    for (const text of texts) {
      for (const term of tokenizeForSearch(text)) {
        counts.set(term, (counts.get(term) ?? 0) + 1);
      }
    }
    const ordered = [...counts.entries()].sort((a, b) => compareText(a[0], b[0]));
    for (const [term, tf] of ordered) {
      out.push({
        term,
        posting: { id: document.id, path: document.path, field, tf },
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Shard construction
 * ------------------------------------------------------------------ */

export function emptyShard(): PostingsShard {
  return { schema: POSTINGS_SCHEMA_VERSION, terms: {} };
}

export function isTruncationMarker(entry: Posting | TruncationMarker): entry is TruncationMarker {
  return 'truncated' in entry;
}

export function isPosting(entry: Posting | TruncationMarker): entry is Posting {
  return !isTruncationMarker(entry);
}

/** The stored postings of a term, without its truncation marker. */
export function queryShard(shard: PostingsShard, term: string): Posting[] {
  const list = shard.terms[term];
  if (!list) return [];
  return list.filter(isPosting);
}

export function isTruncated(shard: PostingsShard, term: string): boolean {
  const list = shard.terms[term];
  if (!list) return false;
  return list.some(isTruncationMarker);
}

/**
 * Number of stored postings.
 *
 * O(1) thanks to the list invariant — sorted postings occupy `0..n-1` and at most one truncation
 * marker sits at the very end (`insertPosting` inserts in front of it, `withMarker` re-appends it).
 */
function countPostings(list: PostingList): number {
  const last = list[list.length - 1];
  return last !== undefined && isTruncationMarker(last) ? list.length - 1 : list.length;
}

function markerOf(list: PostingList): TruncationMarker | undefined {
  const last = list[list.length - 1];
  return last !== undefined && isTruncationMarker(last) ? last : undefined;
}

/** Index of the posting with the same `(id, field)`, or -1. Binary search over the sorted prefix. */
function findPosting(list: PostingList, posting: Posting): number {
  let low = 0;
  let high = countPostings(list) - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const current = list[middle];
    if (current === undefined || isTruncationMarker(current)) break;
    const order = comparePostings(current, posting);
    if (order === 0) return middle;
    if (order < 0) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

/** Rebuild a list with every posting kept and a single marker (carrying `dropped`) at the end. */
function withMarker(list: PostingList, dropped: number): PostingList {
  const next: PostingList = list.filter(isPosting);
  next.push({ truncated: true, dropped: (markerOf(list)?.dropped ?? 0) + dropped });
  return next;
}

function insertPosting(list: PostingList, posting: Posting): PostingList {
  // Scan from the end: record ids are time-sortable, so an append is the common case and costs O(1).
  let at = countPostings(list);
  while (at > 0) {
    const previous = list[at - 1];
    if (previous === undefined) break;
    if (isTruncationMarker(previous)) {
      at -= 1;
      continue;
    }
    if (comparePostings(previous, posting) <= 0) break;
    at -= 1;
  }
  const next = list.slice();
  next.splice(at, 0, posting);
  return next;
}

function upsertPosting(list: PostingList, posting: Posting): PostingList {
  const existing = findPosting(list, posting);
  if (existing >= 0) {
    const current = list[existing];
    if (current && isPosting(current) && current.path === posting.path && current.tf === posting.tf) {
      return list;
    }
    const next = list.slice();
    next[existing] = posting;
    return next;
  }
  if (countPostings(list) >= MAX_POSTINGS_PER_TERM) return withMarker(list, 1);
  return insertPosting(list, posting);
}

/**
 * Add one posting of one term, keeping the list sorted and respecting the cap.
 *
 * Exported because the sharded write path (`SearchIndex`) distributes a document's postings across
 * shards itself; `addRecord` is the whole-document convenience.
 */
export function addPosting(shard: PostingsShard, term: string, posting: Posting): PostingsShard {
  if (term.length === 0) return shard;
  const list = shard.terms[term] ?? [];
  const next = upsertPosting(list, posting);
  if (next === list) return shard;
  return { schema: POSTINGS_SCHEMA_VERSION, terms: { ...shard.terms, [term]: next } };
}

/**
 * The postings of a document grouped by shard key, in deterministic order.
 *
 * The sharded write path computes this **once per document** and then hands each group to
 * {@link addTermPostings}: re-tokenizing a 512 KB body once per touched shard instead would turn a
 * single capture into hundreds of full tokenizations.
 */
export function groupTermPostings(document: SearchDocument): Map<string, TermPosting[]> {
  const grouped = new Map<string, TermPosting[]>();
  for (const entry of termPostings(document)) {
    const key = shardKey(entry.term);
    const list = grouped.get(key);
    if (list) list.push(entry);
    else grouped.set(key, [entry]);
  }
  return grouped;
}

/** Add a batch of `(term, posting)` pairs (typically one {@link groupTermPostings} bucket). */
export function addTermPostings(
  shard: PostingsShard,
  entries: readonly TermPosting[],
): PostingsShard {
  let next = shard;
  for (const { term, posting } of entries) next = addPosting(next, term, posting);
  return next;
}

/**
 * Add every posting of a document to one shard.
 *
 * This is the whole-document form; the sharded index instead groups the document's postings by
 * {@link shardKey} and writes one small file per group.
 */
export function addRecord(shard: PostingsShard, document: SearchDocument): PostingsShard {
  return addTermPostings(shard, termPostings(document));
}

/**
 * Remove every posting of one record id from a shard.
 *
 * A term whose last posting is removed is dropped from the shard entirely — id-only sharding means
 * the caller runs this over each shard the record touched. A truncation marker is preserved while
 * postings remain (removing some other record must not erase the evidence that this term is capped),
 * and dropped with the term once nothing is left to truncate.
 */
export function removeRecord(shard: PostingsShard, id: string): PostingsShard {
  const terms: Record<string, PostingList> = {};
  let changed = false;
  for (const [term, list] of Object.entries(shard.terms)) {
    const postings = list.filter(isPosting);
    const kept = postings.filter((posting) => posting.id !== id);
    if (kept.length === postings.length) {
      terms[term] = list;
      continue;
    }
    changed = true;
    if (kept.length === 0) continue;
    const marker = markerOf(list);
    terms[term] = marker ? [...kept, marker] : kept;
  }
  return changed ? { schema: POSTINGS_SCHEMA_VERSION, terms } : shard;
}

/** Sorted, de-duplicated term list of a shard (the deterministic key order of its JSON). */
export function shardTerms(shard: PostingsShard): string[] {
  return Object.keys(shard.terms).sort(compareText);
}

/* ------------------------------------------------------------------ *
 * Serialization
 * ------------------------------------------------------------------ */

/**
 * Deterministic shard JSON: term keys sorted by code point, postings sorted, one marker last.
 *
 * Stable output is what lets `changedShards` skip a write that would only reshuffle keys, and keeps
 * an ordinary capture from producing a noisy diff in the repository.
 */
export function serializeShard(shard: PostingsShard): string {
  const terms: Record<string, PostingList> = {};
  for (const term of shardTerms(shard)) {
    const list = shard.terms[term];
    if (!list || list.length === 0) continue;
    terms[term] = [...list].sort(compareListEntries);
  }
  return `${JSON.stringify({ schema: POSTINGS_SCHEMA_VERSION, terms }, null, 2)}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePosting(value: unknown): Posting | null {
  if (!isPlainObject(value)) return null;
  const { id, path, field, tf } = value;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof path !== 'string' || path.length === 0) return null;
  if (typeof field !== 'string' || !(FIELD_ORDER as readonly string[]).includes(field)) return null;
  if (typeof tf !== 'number' || !Number.isFinite(tf) || tf <= 0) return null;
  return { id, path, field: field as SearchField, tf };
}

function parseMarker(value: unknown): TruncationMarker | null {
  if (!isPlainObject(value)) return null;
  if (value['truncated'] !== true) return null;
  const dropped = value['dropped'];
  if (typeof dropped !== 'number' || !Number.isFinite(dropped) || dropped < 0) return null;
  return { truncated: true, dropped };
}

/**
 * Tolerant read of a shard file.
 *
 * `null` means "this shard is unusable, rebuild it": not JSON, not an object, wrong schema, or a
 * `terms` payload that is not an object. Individual malformed entries are dropped rather than
 * guessed at (the `parseIndex` rule) — one hand-edited line must not throw away an entire index.
 */
export function parseShard(text: string | null | undefined): PostingsShard | null {
  if (typeof text !== 'string' || text.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed['schema'] !== POSTINGS_SCHEMA_VERSION) return null;
  const rawTerms = parsed['terms'];
  if (!isPlainObject(rawTerms)) return null;

  const terms: Record<string, PostingList> = {};
  for (const [term, rawList] of Object.entries(rawTerms)) {
    if (term.length === 0 || !Array.isArray(rawList)) continue;
    const postings: Posting[] = [];
    let marker: TruncationMarker | null = null;
    for (const entry of rawList) {
      const posting = parsePosting(entry);
      if (posting) {
        postings.push(posting);
        continue;
      }
      const parsedMarker = parseMarker(entry);
      if (parsedMarker) marker = parsedMarker;
    }
    postings.sort(comparePostings);
    const list: PostingList = postings;
    if (marker) list.push(marker);
    if (list.length > 0) terms[term] = list;
  }
  return { schema: POSTINGS_SCHEMA_VERSION, terms };
}

/** `[prefix/]search/<shardKey>.json` — the path a shard is committed to. */
export function shardPath(key: string, prefix?: string | null): string {
  return joinPath(normalizePrefix(prefix), SHARD_DIR, `${key}.json`);
}

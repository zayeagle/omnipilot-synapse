/**
 * Query engine — parsing, scoring and snippet extraction over postings shards.
 *
 * PURE MODULE: no browser, DOM, network or clock access. The clock is injected (`options.now`), so
 * recency ranking is reproducible in a test (TC-F4-U12).
 *
 * Two inputs, because they answer two different questions:
 * - `shards` are the raw `search/<key>.json` payloads. They decide *which* records match a term, and
 *   they are what makes retrieval work from the repository alone.
 * - `docs` is the document table (the decoded local cache). It supplies the title, the field text a
 *   snippet is cut from, and the values the `tag:` / `topic:` / `in:` filters compare against. A
 *   posting deliberately carries no text: repeating a 512 KB body inside every shard a document
 *   touches would dwarf the index it is meant to be.
 *
 * A shard that cannot be read or parsed never throws: it sets `needsRebuild` on the result and is
 * skipped (Err2 — a corrupt index degrades to "rebuild needed").
 */

import { normalizeText } from '../core/dedup';
import { type CkfRecord } from '../core/ckf';
import {
  FIELD_ORDER,
  FIELD_WEIGHTS,
  parseShard,
  queryShard,
  type Posting,
  type PostingsShard,
  type SearchDocument,
  type SearchField,
} from './postings';
import { compareText, shardKey, tokenizeForSearch } from './tokenize';

/** Default result cap. A popup list never needs more. */
export const DEFAULT_LIMIT = 50;

/** Target snippet width in characters (TC-F4-U05 asks for roughly 120). */
export const SNIPPET_LENGTH = 120;

/**
 * Recency half-life: a record gives up half of its recency factor per half-life of age.
 *
 * 180 days is deliberately gentle. Recency must break ties and nudge, not let a fresh one-line body
 * match outrank a well-titled record from last year.
 */
export const RECENCY_HALF_LIFE_MS = 180 * 24 * 60 * 60 * 1000;

/** Decay used for a record with no usable timestamp, so "unknown age" is neither punished nor rewarded. */
export const NEUTRAL_DECAY = 0.5;

const KIND_ALIASES: Record<string, readonly CkfRecord['kind'][]> = {
  inbox: ['source'],
  source: ['source'],
  sources: ['source'],
  cards: ['card'],
  card: ['card'],
  topics: ['topic'],
  topic: ['topic'],
  all: ['source', 'card', 'topic'],
  '*': ['source', 'card', 'topic'],
};

/** One raw shard as the store handed it over: `null` text means "could not be read". */
export interface RawShard {
  key: string;
  text: string | null;
}

/**
 * `tag:` / `topic:` / `in:` filters.
 *
 * `kinds: null` means no `in:` filter was given; `kinds: []` means one was given with a value that
 * matches no record kind, which must select nothing rather than silently selecting everything.
 */
export interface QueryFilter {
  tags: string[];
  topics: string[];
  kinds: CkfRecord['kind'][] | null;
}

/** One parsed term: a bare word or a `"quoted phrase"`. */
export interface QueryTerm {
  /** Normalized text as typed (filters stripped); the preferred snippet needle. */
  text: string;
  /** True for a quoted phrase: its tokens must also be adjacent in one field. */
  phrase: boolean;
  /** Index terms this query term expands to — `间隔` → `间`, `隔`, `间隔`. */
  tokens: readonly string[];
}

export interface ParsedQuery {
  terms: QueryTerm[];
  filters: QueryFilter;
  /** Every {@link QueryTerm.tokens} entry, de-duplicated: the query's expansion into index terms. */
  indexTerms: string[];
}

export interface SearchHit {
  id: string;
  path: string;
  title: string;
  score: number;
  snippet: string;
  /** Fields that matched, in {@link FIELD_ORDER} order. */
  fields: SearchField[];
}

/**
 * Query result.
 *
 * An array of hits that also carries the two facts a caller needs to decide what to do next:
 * whether the index has to be rebuilt, and how the query expanded into index terms (the bigram
 * evidence TC-F4-U07 asserts on). Plain arrays keep `results.forEach(...)`, `results.length` and
 * serialization-to-a-list working exactly as expected.
 */
export type SearchResponse = SearchHit[] & {
  readonly needsRebuild: boolean;
  readonly terms: readonly string[];
};

export interface SearchOptions {
  /** Document table (local cache first). Missing documents simply cannot be returned. */
  docs: readonly SearchDocument[];
  /** Injected clock, epoch milliseconds. */
  now: () => number;
  limit?: number;
}

/* ------------------------------------------------------------------ *
 * Parsing
 * ------------------------------------------------------------------ */

interface QuerySegment {
  text: string;
  phrase: boolean;
}

const FILTER_PATTERN = /^(tag|topic|in):(.*)$/iu;

/** Split a raw query into `"quoted phrases"` and bare words, honouring an unterminated quote. */
function splitSegments(raw: string): QuerySegment[] {
  const out: QuerySegment[] = [];
  // A fresh regex per call: a `g` regex carries `lastIndex` between calls.
  const pattern = /"([^"]*)"|(\S+)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const quoted = match[1];
    if (quoted !== undefined) {
      out.push({ text: quoted, phrase: true });
      continue;
    }
    const word = match[2] ?? '';
    if (word.startsWith('"')) {
      out.push({ text: word.slice(1), phrase: true });
      continue;
    }
    out.push({ text: word, phrase: false });
  }
  return out;
}

function applyKindFilter(filters: QueryFilter, rawValue: string): void {
  const kinds: CkfRecord['kind'][] = [];
  for (const part of rawValue.split(/[|,]/u)) {
    const value = part.trim().toLowerCase();
    if (value === '') continue;
    for (const kind of KIND_ALIASES[value] ?? []) {
      if (!kinds.includes(kind)) kinds.push(kind);
    }
  }
  // A second `in:` narrows rather than replaces; an unknown value leaves it empty (matches nothing).
  filters.kinds = filters.kinds === null ? kinds : filters.kinds.filter((kind) => kinds.includes(kind));
}

/**
 * Parse a raw query.
 *
 * Terms are de-duplicated by normalized text. A segment that produces no index term (punctuation
 * only, or a filter-like word with an empty value) is dropped, which is what makes a
 * punctuation-only query an empty query rather than a query that matches everything.
 */
export function parseQuery(rawQuery: string): ParsedQuery {
  const filters: QueryFilter = { tags: [], topics: [], kinds: null };
  const terms: QueryTerm[] = [];
  const seenTerms = new Set<string>();
  const indexTerms: string[] = [];
  const seenIndex = new Set<string>();

  for (const segment of splitSegments(rawQuery ?? '')) {
    if (!segment.phrase) {
      const filter = FILTER_PATTERN.exec(segment.text);
      if (filter) {
        const name = (filter[1] ?? '').toLowerCase();
        const value = (filter[2] ?? '').trim().toLowerCase();
        if (name === 'tag' && value !== '') filters.tags.push(value);
        else if (name === 'topic' && value !== '') filters.topics.push(value);
        else if (name === 'in') applyKindFilter(filters, value);
        continue;
      }
    }

    const tokens = tokenizeForSearch(segment.text);
    if (tokens.length === 0) continue;
    const text = normalizeText(segment.text);
    if (text === '' || seenTerms.has(text)) continue;
    seenTerms.add(text);
    terms.push({ text, phrase: segment.phrase, tokens });
    for (const token of tokens) {
      if (seenIndex.has(token)) continue;
      seenIndex.add(token);
      indexTerms.push(token);
    }
  }

  return { terms, filters, indexTerms };
}

export function isEmptyQuery(parsed: ParsedQuery): boolean {
  return (
    parsed.terms.length === 0 &&
    parsed.filters.tags.length === 0 &&
    parsed.filters.topics.length === 0 &&
    parsed.filters.kinds === null
  );
}

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

/** 0.5 ** (age / half-life): 1 for "just captured", strictly decreasing with age. */
export function recencyDecay(updatedAt: string, now: number): number {
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) return NEUTRAL_DECAY;
  const age = Math.max(0, now - at);
  return 0.5 ** (age / RECENCY_HALF_LIFE_MS);
}

export interface ScoreInput {
  /** Index terms of the query that this document matched. */
  matchedIndexTerms: number;
  /** Index terms in the query (0 for a filter-only query). */
  totalIndexTerms: number;
  /** Best field weight per matched query term. */
  fieldWeights: readonly number[];
  updatedAt: string;
  now: number;
}

/**
 * `coverage × field weight × recency decay` (04-design F4 step 2).
 *
 * Coverage is measured at *index-term* granularity, which is what makes `间隔` prefer a document that
 * really contains `间隔` (3/3 terms) over one that merely contains both characters apart (2/3).
 * A filter-only query has no terms and therefore full coverage, weighted neutrally, so its ordering
 * is purely recency.
 */
export function scoreHit(input: ScoreInput): number {
  const coverage = input.totalIndexTerms === 0 ? 1 : input.matchedIndexTerms / input.totalIndexTerms;
  const weight =
    input.fieldWeights.length === 0
      ? 1
      : input.fieldWeights.reduce((sum, value) => sum + value, 0) / input.fieldWeights.length;
  return coverage * weight * recencyDecay(input.updatedAt, input.now);
}

/* ------------------------------------------------------------------ *
 * Snippets
 * ------------------------------------------------------------------ */

function utf16ToCodePointIndex(text: string, utf16Index: number): number {
  return Array.from(text.slice(0, utf16Index)).length;
}

function windowOf(text: string, codePointIndex: number): string {
  const characters = Array.from(text);
  if (characters.length <= SNIPPET_LENGTH) return text;
  const half = Math.floor(SNIPPET_LENGTH / 2);
  const start = Math.max(0, Math.min(codePointIndex - half, characters.length - SNIPPET_LENGTH));
  const window = characters.slice(start, start + SNIPPET_LENGTH).join('');
  const prefix = start > 0 ? '…' : '';
  const suffix = start + SNIPPET_LENGTH < characters.length ? '…' : '';
  return `${prefix}${window}${suffix}`;
}

/** A character window of `text` centred on the first occurrence of `needle`. */
export function snippetAround(text: string, needle: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const folded = flat.toLowerCase();
  const wanted = needle.trim().toLowerCase();
  if (wanted === '') return windowOf(flat, 0);
  const at = folded.indexOf(wanted);
  if (at < 0) return windowOf(flat, 0);
  return windowOf(flat, utf16ToCodePointIndex(folded, at));
}

function needlesOf(term: QueryTerm): string[] {
  const needles = [term.text, ...term.tokens];
  return [...new Set(needles.filter((needle) => needle !== ''))].sort(
    (a, b) => Array.from(b).length - Array.from(a).length || compareText(a, b),
  );
}

function snippetFor(
  doc: SearchDocument,
  term: QueryTerm,
  fields: readonly SearchField[],
): string {
  const needles = needlesOf(term);
  for (const field of fields) {
    for (const text of doc.fields[field] ?? []) {
      for (const needle of needles) {
        if (text.toLowerCase().includes(needle)) return snippetAround(text, needle);
      }
    }
  }
  for (const field of FIELD_ORDER) {
    const first = (doc.fields[field] ?? []).find((text) => text.trim() !== '');
    if (first !== undefined) return snippetAround(first, '');
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

function hasValue(values: readonly string[] | undefined, wanted: string): boolean {
  if (!values) return false;
  return values.some((value) => {
    const normalized = normalizeText(value);
    return normalized === wanted || normalized.includes(wanted);
  });
}

function matchesFilters(doc: SearchDocument, filters: QueryFilter): boolean {
  if (filters.kinds !== null && !filters.kinds.includes(doc.kind)) return false;
  for (const tag of filters.tags) if (!hasValue(doc.fields.tag, tag)) return false;
  for (const topic of filters.topics) if (!hasValue(doc.fields.topic, topic)) return false;
  return true;
}

function fieldContains(doc: SearchDocument, field: SearchField, phrase: string): boolean {
  const wanted = normalizeText(phrase);
  if (wanted === '') return false;
  return (doc.fields[field] ?? []).some((text) => normalizeText(text).includes(wanted));
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

function readShards(shards: readonly RawShard[]): {
  byKey: Map<string, PostingsShard>;
  needsRebuild: boolean;
} {
  const byKey = new Map<string, PostingsShard>();
  let needsRebuild = false;
  for (const shard of shards) {
    if (shard.text === null || shard.text === undefined) {
      // The store could not deliver the shard: the index may be missing data.
      needsRebuild = true;
      continue;
    }
    const parsed = parseShard(shard.text);
    if (!parsed) {
      needsRebuild = true;
      continue;
    }
    byKey.set(shard.key, parsed);
  }
  return { byKey, needsRebuild };
}

function emptyResponse(needsRebuild: boolean, terms: readonly string[]): SearchResponse {
  return Object.assign([] as SearchHit[], { needsRebuild, terms });
}

interface Candidate {
  doc: SearchDocument;
  matchedIndexTerms: number;
  fields: Set<SearchField>;
}

/** Best field weight of a term for one document, plus the fields that matched. */
function weightOf(
  doc: SearchDocument,
  term: QueryTerm,
  postingsByTerm: ReadonlyMap<string, ReadonlyMap<string, Posting[]>>,
): { weight: number; fields: SearchField[] } {
  if (term.phrase) {
    const fields: SearchField[] = [];
    let weight = 0;
    for (const field of FIELD_ORDER) {
      if (!fieldContains(doc, field, term.text)) continue;
      fields.push(field);
      weight = Math.max(weight, FIELD_WEIGHTS[field]);
    }
    return { weight, fields };
  }
  let weight = 0;
  const fields = new Set<SearchField>();
  for (const token of term.tokens) {
    for (const posting of postingsByTerm.get(token)?.get(doc.id) ?? []) {
      fields.add(posting.field);
      weight = Math.max(weight, FIELD_WEIGHTS[posting.field]);
    }
  }
  return { weight, fields: FIELD_ORDER.filter((field) => fields.has(field)) };
}

/**
 * Run a query.
 *
 * Never throws: an empty or punctuation-only query returns no hits (Err1), and an unusable shard
 * only raises `needsRebuild` (Err2).
 */
export function search(
  shards: readonly RawShard[],
  rawQuery: string,
  options: SearchOptions,
): SearchResponse {
  const parsed = parseQuery(rawQuery);
  const { byKey, needsRebuild } = readShards(shards);
  const limit = options.limit ?? DEFAULT_LIMIT;

  if (isEmptyQuery(parsed) || limit <= 0) return emptyResponse(needsRebuild, parsed.indexTerms);

  const allowed: SearchDocument[] = [];
  const docsById = new Map<string, SearchDocument>();
  for (const doc of options.docs) {
    if (!matchesFilters(doc, parsed.filters)) continue;
    allowed.push(doc);
    docsById.set(doc.id, doc);
  }
  if (allowed.length === 0) return emptyResponse(needsRebuild, parsed.indexTerms);

  const now = options.now();

  // Filter-only query: every surviving document is a hit, ordered by recency.
  if (parsed.indexTerms.length === 0) {
    const hits = allowed.map((doc) => ({
      id: doc.id,
      path: doc.path,
      title: doc.title,
      score: scoreHit({
        matchedIndexTerms: 0,
        totalIndexTerms: 0,
        fieldWeights: [],
        updatedAt: doc.updated_at,
        now,
      }),
      snippet: snippetFor(doc, { text: '', phrase: false, tokens: [] }, []),
      fields: [] as SearchField[],
    }));
    return Object.assign(sortHits(hits).slice(0, limit), {
      needsRebuild,
      terms: parsed.indexTerms,
    });
  }

  // Expansion term → postings per document id. Only documents in the table can be returned.
  const postingsByTerm = new Map<string, Map<string, Posting[]>>();
  const candidates = new Map<string, Candidate>();
  for (const term of parsed.indexTerms) {
    const shard = byKey.get(shardKey(term));
    if (!shard) continue;
    const byId = new Map<string, Posting[]>();
    for (const posting of queryShard(shard, term)) {
      const doc = docsById.get(posting.id);
      if (!doc) continue;
      const list = byId.get(posting.id);
      if (list) list.push(posting);
      else byId.set(posting.id, [posting]);
    }
    postingsByTerm.set(term, byId);
    for (const [id, postings] of byId) {
      const doc = docsById.get(id);
      if (!doc) continue;
      let candidate = candidates.get(id);
      if (!candidate) {
        candidate = { doc, matchedIndexTerms: 0, fields: new Set<SearchField>() };
        candidates.set(id, candidate);
      }
      candidate.matchedIndexTerms += 1;
      for (const posting of postings) candidate.fields.add(posting.field);
    }
  }

  const hits: SearchHit[] = [];
  for (const candidate of candidates.values()) {
    const weights: number[] = [];
    const matchedFields = new Set<SearchField>(candidate.fields);
    let bestTerm: QueryTerm | null = null;
    let bestWeight = -1;
    let rejected = false;

    for (const term of parsed.terms) {
      const { weight, fields } = weightOf(candidate.doc, term, postingsByTerm);
      if (weight === 0) {
        // A phrase whose words are present but not adjacent is not a match at all.
        if (term.phrase) {
          rejected = true;
          break;
        }
        continue;
      }
      for (const field of fields) matchedFields.add(field);
      weights.push(weight);
      if (weight > bestWeight) {
        bestWeight = weight;
        bestTerm = term;
      }
    }

    if (rejected || weights.length === 0) continue;
    const fields = FIELD_ORDER.filter((field) => matchedFields.has(field));
    hits.push({
      id: candidate.doc.id,
      path: candidate.doc.path,
      title: candidate.doc.title,
      score: scoreHit({
        matchedIndexTerms: candidate.matchedIndexTerms,
        totalIndexTerms: parsed.indexTerms.length,
        fieldWeights: weights,
        updatedAt: candidate.doc.updated_at,
        now,
      }),
      snippet: bestTerm === null ? '' : snippetFor(candidate.doc, bestTerm, fields),
      fields,
    });
  }

  return Object.assign(sortHits(hits).slice(0, limit), {
    needsRebuild,
    terms: parsed.indexTerms,
  });
}

/** Score descending, then id ascending — a total order, so a rebuild returns the same list. */
function sortHits(hits: SearchHit[]): SearchHit[] {
  return hits.sort(
    (a, b) => (b.score !== a.score ? b.score - a.score : compareText(a.id, b.id)),
  );
}

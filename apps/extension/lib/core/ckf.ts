/**
 * Canonical Knowledge Format (CKF) — the storage-agnostic record model.
 *
 * PURE MODULE: no browser, DOM, network or storage APIs. Everything the extension persists is
 * expressed with these types, so a second storage adapter (or the future WeChat Mini Program)
 * can round-trip the same data without knowing about GitHub. `lib/core/purity.test.ts` enforces it.
 */

import { contentKey } from './dedup';
import { newId } from './paths';

export type SourceChannel = 'extension' | 'manual' | 'import';
export type ExtractionQuality = 'full' | 'title-only';
export type CardStatus = 'pending' | 'confirmed';
export type SelfRating = 'known' | 'fuzzy' | 'forgotten';

export class CkfError extends Error {
  readonly field: string;
  readonly reason: string;

  constructor(field: string, reason: string) {
    super(`ckf: field "${field}" ${reason}`);
    this.name = 'CkfError';
    this.field = field;
    this.reason = reason;
  }
}

export interface SourceItem {
  id: string;
  kind: 'source';
  channel: SourceChannel;
  url: string;
  title: string;
  body: string;
  content_hash: string;
  captured_at: string;
  tags: string[];
  byline?: string;
  lang?: string;
  /** Set when this record is a selection excerpt taken from `excerpt_of`. */
  excerpt_of?: string;
  truncated?: boolean;
  original_bytes?: number;
  extraction?: ExtractionQuality;
}

export interface DistillProvenance {
  provider: string;
  model: string;
  at: string;
}

export interface KnowledgeCard {
  id: string;
  kind: 'card';
  source_id: string;
  title: string;
  summary: string;
  points: string[];
  tags: string[];
  evidence_paths: string[];
  status: CardStatus;
  scenarios?: string[];
  counter_examples?: string[];
  topic_id?: string;
  distilled_by?: DistillProvenance;
}

export interface Topic {
  id: string;
  kind: 'topic';
  name: string;
  path: string;
  parent_id?: string;
}

export interface ReviewState {
  id: string;
  kind: 'review';
  stability: number;
  retrievability: number;
  next_review_at: string;
  use_count: number;
  last_reviewed_at?: string;
  self_rating?: SelfRating;
}

/* ------------------------------------------------------------------ *
 * Primitive validators — strict, so a corrupt record can never become
 * a partially valid one (SC-F2-02).
 * ------------------------------------------------------------------ */

type Raw = Record<string, unknown>;

function record(value: unknown, field: string): Raw {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CkfError(field, 'must be an object');
  }
  return value as Raw;
}

function str(source: Raw, field: string): string {
  const value = source[field];
  if (typeof value !== 'string') throw new CkfError(field, 'must be a string');
  return value;
}

function nonEmptyStr(source: Raw, field: string): string {
  const value = str(source, field);
  if (value.length === 0) throw new CkfError(field, 'must not be empty');
  return value;
}

function optStr(source: Raw, field: string): string | undefined {
  const value = source[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new CkfError(field, 'must be a string when present');
  return value;
}

function optBool(source: Raw, field: string): boolean | undefined {
  const value = source[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new CkfError(field, 'must be a boolean when present');
  return value;
}

function optNum(source: Raw, field: string): number | undefined {
  const value = source[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CkfError(field, 'must be a finite number when present');
  }
  return value;
}

function num(source: Raw, field: string): number {
  const value = optNum(source, field);
  if (value === undefined) throw new CkfError(field, 'is required');
  return value;
}

function strArray(source: Raw, field: string, required: boolean): string[] {
  const value = source[field];
  if (value === undefined || value === null) {
    if (required) throw new CkfError(field, 'is required');
    return [];
  }
  if (!Array.isArray(value)) throw new CkfError(field, 'must be an array of strings');
  return value.map((entry, index) => {
    if (typeof entry !== 'string') throw new CkfError(`${field}[${index}]`, 'must be a string');
    return entry;
  });
}

function optStrArray(source: Raw, field: string): string[] | undefined {
  if (source[field] === undefined || source[field] === null) return undefined;
  return strArray(source, field, false);
}

function oneOf<T extends string>(source: Raw, field: string, allowed: readonly T[]): T {
  const value = str(source, field);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new CkfError(field, `must be one of ${allowed.join(' | ')}`);
  }
  return value as T;
}

export function isIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function isoStr(source: Raw, field: string): string {
  const value = nonEmptyStr(source, field);
  if (!isIsoTimestamp(value)) throw new CkfError(field, 'must be an ISO-8601 timestamp');
  return value;
}

/* ------------------------------------------------------------------ *
 * Parsers — explicit field lists mean unknown keys are dropped, never
 * carried through to storage.
 * ------------------------------------------------------------------ */

export function parseSourceItem(value: unknown): SourceItem {
  const raw = record(value, 'source');
  const item: SourceItem = {
    id: nonEmptyStr(raw, 'id'),
    kind: 'source',
    channel: oneOf(raw, 'channel', ['extension', 'manual', 'import'] as const),
    url: str(raw, 'url'),
    title: str(raw, 'title'),
    body: str(raw, 'body'),
    content_hash: nonEmptyStr(raw, 'content_hash'),
    captured_at: isoStr(raw, 'captured_at'),
    tags: strArray(raw, 'tags', true),
  };
  const byline = optStr(raw, 'byline');
  if (byline !== undefined) item.byline = byline;
  const lang = optStr(raw, 'lang');
  if (lang !== undefined) item.lang = lang;
  const excerptOf = optStr(raw, 'excerpt_of');
  if (excerptOf !== undefined) item.excerpt_of = excerptOf;
  const truncated = optBool(raw, 'truncated');
  if (truncated !== undefined) item.truncated = truncated;
  const originalBytes = optNum(raw, 'original_bytes');
  if (originalBytes !== undefined) item.original_bytes = originalBytes;
  const extraction = optStr(raw, 'extraction');
  if (extraction !== undefined) {
    if (extraction !== 'full' && extraction !== 'title-only') {
      throw new CkfError('extraction', 'must be full | title-only');
    }
    item.extraction = extraction;
  }
  if (item.truncated === true && item.original_bytes === undefined) {
    throw new CkfError('original_bytes', 'is required when truncated is true');
  }
  return item;
}

export interface KnowledgeCardParseOptions {
  /** When false (reading an already stored card) `status` may be absent and defaults to pending. */
  requireStatus?: boolean;
}

export function parseKnowledgeCard(
  value: unknown,
  options: KnowledgeCardParseOptions = {},
): KnowledgeCard {
  const raw = record(value, 'card');
  const card: KnowledgeCard = {
    id: nonEmptyStr(raw, 'id'),
    kind: 'card',
    source_id: nonEmptyStr(raw, 'source_id'),
    title: nonEmptyStr(raw, 'title'),
    summary: str(raw, 'summary'),
    points: strArray(raw, 'points', true),
    tags: strArray(raw, 'tags', true),
    evidence_paths: strArray(raw, 'evidence_paths', true),
    status: 'pending',
  };
  if (raw['status'] !== undefined || options.requireStatus) {
    card.status = oneOf(raw, 'status', ['pending', 'confirmed'] as const);
  }
  const scenarios = optStrArray(raw, 'scenarios');
  if (scenarios !== undefined) card.scenarios = scenarios;
  const counterExamples = optStrArray(raw, 'counter_examples');
  if (counterExamples !== undefined) card.counter_examples = counterExamples;
  const topicId = optStr(raw, 'topic_id');
  if (topicId !== undefined) card.topic_id = topicId;
  if (raw['distilled_by'] !== undefined && raw['distilled_by'] !== null) {
    const provenance = record(raw['distilled_by'], 'distilled_by');
    card.distilled_by = {
      provider: nonEmptyStr(provenance, 'provider'),
      model: nonEmptyStr(provenance, 'model'),
      at: isoStr(provenance, 'at'),
    };
  }
  if (card.points.length === 0) throw new CkfError('points', 'must contain at least one point');
  return card;
}

export function parseTopic(value: unknown): Topic {
  const raw = record(value, 'topic');
  const topic: Topic = {
    id: nonEmptyStr(raw, 'id'),
    kind: 'topic',
    name: nonEmptyStr(raw, 'name'),
    path: str(raw, 'path'),
  };
  const parentId = optStr(raw, 'parent_id');
  if (parentId !== undefined) topic.parent_id = parentId;
  return topic;
}

export function parseReviewState(value: unknown): ReviewState {
  const raw = record(value, 'review');
  const state: ReviewState = {
    id: nonEmptyStr(raw, 'id'),
    kind: 'review',
    stability: num(raw, 'stability'),
    retrievability: num(raw, 'retrievability'),
    next_review_at: isoStr(raw, 'next_review_at'),
    use_count: num(raw, 'use_count'),
  };
  const lastReviewedAt = optStr(raw, 'last_reviewed_at');
  if (lastReviewedAt !== undefined) {
    if (!isIsoTimestamp(lastReviewedAt)) {
      throw new CkfError('last_reviewed_at', 'must be an ISO-8601 timestamp');
    }
    state.last_reviewed_at = lastReviewedAt;
  }
  const selfRating = optStr(raw, 'self_rating');
  if (selfRating !== undefined) {
    state.self_rating = oneOf(raw, 'self_rating', ['known', 'fuzzy', 'forgotten'] as const);
  }
  return state;
}

/* ------------------------------------------------------------------ *
 * Factories
 * ------------------------------------------------------------------ */

export interface SourceItemInput {
  url: string;
  title: string;
  body: string;
  channel?: SourceChannel;
  tags?: string[];
  byline?: string;
  lang?: string;
  excerpt_of?: string;
  truncated?: boolean;
  original_bytes?: number;
  extraction?: ExtractionQuality;
  /** Injected for deterministic tests; defaults to `Date.now`. */
  capturedAt?: Date;
  id?: string;
}

export function newSourceItem(input: SourceItemInput): SourceItem {
  const capturedAt = input.capturedAt ?? new Date();
  const item: SourceItem = {
    id: input.id ?? newId(() => capturedAt.getTime()),
    kind: 'source',
    channel: input.channel ?? 'extension',
    url: input.url,
    title: input.title,
    body: input.body,
    content_hash: contentKey(input.body),
    captured_at: capturedAt.toISOString(),
    tags: input.tags ?? [],
  };
  if (input.byline) item.byline = input.byline;
  if (input.lang) item.lang = input.lang;
  if (input.excerpt_of) item.excerpt_of = input.excerpt_of;
  if (input.extraction) item.extraction = input.extraction;
  if (input.truncated) {
    item.truncated = true;
    item.original_bytes = input.original_bytes ?? input.body.length;
  }
  return item;
}

export interface KnowledgeCardInput {
  source_id: string;
  title: string;
  summary: string;
  points: string[];
  evidence_paths: string[];
  tags?: string[];
  scenarios?: string[];
  counter_examples?: string[];
  topic_id?: string;
  distilled_by?: DistillProvenance;
  status?: CardStatus;
  id?: string;
}

export function newKnowledgeCard(input: KnowledgeCardInput): KnowledgeCard {
  const card: KnowledgeCard = {
    id: input.id ?? newId(),
    kind: 'card',
    source_id: input.source_id,
    title: input.title,
    summary: input.summary,
    points: [...input.points],
    tags: input.tags ?? [],
    evidence_paths: [...input.evidence_paths],
    status: input.status ?? 'pending',
  };
  if (input.scenarios?.length) card.scenarios = [...input.scenarios];
  if (input.counter_examples?.length) card.counter_examples = [...input.counter_examples];
  if (input.topic_id) card.topic_id = input.topic_id;
  if (input.distilled_by) card.distilled_by = { ...input.distilled_by };
  return card;
}

/** Record kinds that can live in the knowledge base. */
export type CkfRecord = SourceItem | KnowledgeCard | Topic | ReviewState;

export function parseCkfRecord(value: unknown): CkfRecord {
  const raw = record(value, 'record');
  switch (raw['kind']) {
    case 'source':
      return parseSourceItem(raw);
    case 'card':
      return parseKnowledgeCard(raw);
    case 'topic':
      return parseTopic(raw);
    case 'review':
      return parseReviewState(raw);
    default:
      throw new CkfError('kind', 'must be one of source | card | topic | review');
  }
}

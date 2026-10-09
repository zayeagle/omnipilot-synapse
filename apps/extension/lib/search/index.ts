/**
 * `SearchIndex` — orchestration over an injected shard store.
 *
 * This is the only module in `lib/search` that performs I/O, and even here every collaborator is
 * injected ({@link SearchStore}, the clock, the document table), so the whole index can be exercised
 * against an in-memory fake (TC-F4-I01…I03).
 *
 * **The index is always rebuildable from the repository.** Shards hold nothing that is not derivable
 * from the notes themselves, which is why a corrupt shard degrades to `needsRebuild` instead of
 * data loss, and why `search/` is documented as safe to delete (04-design F6 step 5, SC-F6-03).
 *
 * Write contract (what the sync engine has to know):
 *
 * 1. `changedShards(record, previous?)` **computes** the shard files a record touches (and remembers
 *    the document so this instance can still answer queries), but does not write to the store. Add
 *    the note file to the same array and commit it all in ONE commit — the note and its shards must
 *    land together or the index can briefly disagree with the repository.
 * 2. `applyShards(files)` persists files produced by step 1. Call it if you committed them yourself;
 *    skip it if you used `upsert`, which does both.
 * 3. `upsert(record, previous?)` = `changedShards` + `applyShards` + document-table update. It returns
 *    the same files, so a caller can still fold them into its own commit.
 *
 * A shard file is `[prefix/]search/<shardKey>.json`, and each file stays small because a term only
 * ever lives in one of them.
 */

import { mapWithConcurrency } from '../concurrency';
import { type CkfRecord } from '../core/ckf';
import { cardPath, sourceItemPath, topicPath } from '../core/paths';
import { type RepoFile } from '../store/types';
import {
  addTermPostings,
  documentOf,
  emptyShard,
  groupTermPostings,
  parseShard,
  removeRecord,
  serializeShard,
  shardPath,
  type PostingsShard,
  type SearchDocument,
  type TermPosting,
} from './postings';
import {
  DEFAULT_LIMIT,
  search,
  type RawShard,
  type SearchHit,
  type SearchResponse,
} from './query';
import { compareText, isShardKey, shardKey } from './tokenize';

/**
 * How many shard reads may be in flight at once.
 *
 * A page's vocabulary spans hundreds of shards, and one serial read per shard is what made a capture
 * that is meant to be two steps take as long as a full index rebuild. Eight takes the win without
 * turning one capture into a burst a host would rate-limit.
 */
const SHARD_READ_CONCURRENCY = 8;

/**
 * What a directory listing can carry before it may be truncated.
 *
 * {@link SearchStore.listShards} is used as evidence that a shard does not exist, and a listing that
 * came back at its own ceiling is not evidence: at that size every candidate is read instead.
 */
const DIRECTORY_LISTING_CEILING = 1000;

/**
 * The narrow slice of the repository the index needs.
 *
 * Deliberately not `KnowledgeStore`: the index reads and writes a handful of small JSON files, and a
 * fake implementing these four members is enough to test the whole feature.
 */
export interface SearchStore {
  /** Shard keys present in `search/` (bare keys, not paths). */
  listShards(): Promise<readonly string[]>;
  /** Raw shard text, or `null` when the shard is absent or could not be read. */
  readShard(key: string): Promise<string | null>;
  /** Persist one shard. Pair it with a commit of the returned `{ path, content }`. */
  writeShard(key: string, content: string): Promise<void>;
  /** Optional: drop a shard that has become obsolete. Without it the shard is blanked instead. */
  removeShard?(key: string): Promise<void>;
}

export interface SearchIndexOptions {
  store: SearchStore;
  /** Repository path prefix; the shards live under `<prefix>/search/`. */
  prefix?: string | null;
  /** Injected clock, epoch milliseconds. */
  now?: () => number;
  /** Repository path of a record. Defaults to {@link defaultRecordPath}. */
  pathOf?: (record: CkfRecord) => string;
  /**
   * The document table, read from the decoded local cache first.
   *
   * Whatever this returns wins over the table the index built from its own `upsert` calls, so a warm
   * cache can hand over richer text than a cold index knows about (04-design F4 step 3).
   */
  docs?: () => Promise<readonly SearchDocument[]>;
}

/**
 * Default repository path of a record — the same paths `store/codec.ts` derives, without pulling the
 * codec (and therefore WebCrypto) into the search layer.
 *
 * Review state has no readable content and is never indexed, so it has no searchable path.
 */
export function defaultRecordPath(record: CkfRecord, prefix?: string | null): string {
  switch (record.kind) {
    case 'source':
      return sourceItemPath(record, prefix);
    case 'card':
      return cardPath(record, prefix);
    case 'topic':
      return topicPath(record, prefix);
    case 'review':
      throw new Error('search: review state is scheduling metadata and is never indexed');
  }
}

/** `search/<key>.json` → `<key>`; the inverse of {@link shardPath}. */
export function shardKeyFromPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
}

export class SearchIndex {
  private readonly store: SearchStore;
  private readonly prefix: string | null;
  private readonly now: () => number;
  private readonly pathOf: (record: CkfRecord) => string;
  private readonly externalDocs: (() => Promise<readonly SearchDocument[]>) | null;
  /** Documents seen through this instance, so `query` can answer without a second source. */
  private readonly table = new Map<string, SearchDocument>();

  constructor(options: SearchIndexOptions) {
    this.store = options.store;
    this.prefix = options.prefix ?? null;
    this.now = options.now ?? Date.now;
    this.pathOf =
      options.pathOf ?? ((record: CkfRecord): string => defaultRecordPath(record, this.prefix));
    this.externalDocs = options.docs ?? null;
  }

  /* ---------------------------------------------------------------- *
   * Pure planning
   * ---------------------------------------------------------------- */

  /** The shard keys a record touches, sorted and de-duplicated. `[]` for review state. */
  shardsFor(record: CkfRecord): string[] {
    if (record.kind === 'review') return [];
    return this.keysOf(documentOf(record, this.pathOf(record)));
  }

  private keysOf(document: SearchDocument): string[] {
    return [...groupTermPostings(document).keys()].sort(compareText);
  }

  /* ---------------------------------------------------------------- *
   * Writes
   * ---------------------------------------------------------------- */

  /**
   * Compute the shard files a record changes, and remember the record for this instance's queries.
   *
   * The store is **not** touched: a caller that owns the commit folds the returned files into the
   * same commit as the note and then calls {@link applyShards} (or simply uses {@link upsert}).
   *
   * `previous` is the record as it was before this write (update, confirm, re-distill). Passing it
   * removes the stale postings and lets the caller see both sides of the change in one commit.
   * Returns only the files whose content actually differs, so a no-op write produces no diff.
   */
  async changedShards(record: CkfRecord, previous?: CkfRecord): Promise<RepoFile[]> {
    const files = await this.planShards(record, previous);
    this.remember(record);
    return files;
  }

  /** The pure(-ish) half of {@link changedShards}: reads the store, writes nothing. */
  private async planShards(record: CkfRecord, previous?: CkfRecord): Promise<RepoFile[]> {
    const next = record.kind === 'review' ? null : documentOf(record, this.pathOf(record));
    const prev =
      previous !== undefined && previous.kind !== 'review'
        ? documentOf(previous, this.pathOf(previous))
        : null;
    if (next === null && prev === null) return [];

    // Tokenize each side once, then distribute; never once per shard.
    const nextGroups = next === null ? new Map<string, TermPosting[]>() : groupTermPostings(next);
    const keys = new Set<string>(nextGroups.keys());
    if (prev !== null) for (const key of this.keysOf(prev)) keys.add(key);

    const ordered = [...keys].sort(compareText);
    const existing = await this.readShards(ordered);

    const files: RepoFile[] = [];
    for (const key of ordered) {
      const text = existing.get(key) ?? null;
      const parsed = parseShard(text);
      // A corrupt shard is repaired by this write instead of being silently skipped.
      const corrupt = parsed === null && typeof text === 'string' && text.trim() !== '';
      const current = parsed ?? emptyShard();
      let updated = prev === null ? current : removeRecord(current, prev.id);
      updated = addTermPostings(updated, nextGroups.get(key) ?? []);
      const content = serializeShard(updated);
      if (corrupt || content !== serializeShard(current)) {
        files.push({ path: shardPath(key, this.prefix), content });
      }
    }
    return files;
  }

  /**
   * Read the shards a write may touch — and only the ones that exist.
   *
   * A term only ever lives in one shard, so a page's vocabulary asks about every bucket it could touch,
   * and some of them have no shard yet. Reading each of those misses one at a time is what made a capture
   * wait on serial round trips; the listing costs one round trip and turns every miss into local work,
   * after which the reads that remain run concurrently.
   *
   * Best-effort by construction: a store that cannot list falls back to reading every key (the previous
   * behaviour), and a read that fails still surfaces to the caller's own error handling.
   */
  private async readShards(keys: readonly string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (const key of keys) out.set(key, null);
    if (keys.length === 0) return out;

    let wanted: readonly string[] = keys;
    try {
      const listed = await this.store.listShards();
      if (listed.length < DIRECTORY_LISTING_CEILING) {
        const present = new Set(listed);
        wanted = keys.filter((key) => present.has(key));
      }
    } catch {
      // The listing is an optimisation: a store that cannot answer it is read key by key.
    }

    await mapWithConcurrency(wanted, SHARD_READ_CONCURRENCY, async (key) => {
      out.set(key, await this.store.readShard(key));
    });
    return out;
  }

  /**
   * Persist files produced by {@link changedShards} (or by {@link rebuild}).
   *
   * `changedShards` + `applyShards` is the "commit the note and its shards together" path; `upsert`
   * is the two of them fused.
   */
  async applyShards(files: readonly RepoFile[]): Promise<void> {
    for (const file of files) {
      await this.store.writeShard(shardKeyFromPath(file.path), file.content);
    }
  }

  /** Remember (or forget) a record in the document table used to answer queries. */
  private remember(record: CkfRecord): void {
    if (record.kind === 'review') this.table.delete(record.id);
    else this.table.set(record.id, documentOf(record, this.pathOf(record)));
  }

  /**
   * Index a record: recompute its shards, write them and remember the document.
   *
   * Returns the files written, so a caller that owns the commit can fold them into it; the store is
   * already consistent either way.
   */
  async upsert(record: CkfRecord, previous?: CkfRecord): Promise<RepoFile[]> {
    const files = await this.changedShards(record, previous);
    await this.applyShards(files);
    return files;
  }

  /**
   * Remove a record's postings.
   *
   * With `previous` only the shards that record touched are read. Without it every shard is scanned,
   * because a bare id says nothing about which terms it was indexed under — a delete has no text to
   * work from. Prefer passing the record that is being deleted.
   *
   * `path` guards the in-memory document table: the cached document is evicted only when it is the
   * one that was asked for, so a stale id cannot evict a newer record.
   */
  async remove(id: string, path: string, previous?: CkfRecord): Promise<RepoFile[]> {
    const keys =
      previous !== undefined && previous.kind !== 'review'
        ? this.keysOf(documentOf(previous, this.pathOf(previous)))
        : await this.listShardKeys();

    const files: RepoFile[] = [];
    for (const key of keys) {
      const text = await this.store.readShard(key);
      const current = parseShard(text);
      if (current === null) continue;
      const updated = removeRecord(current, id);
      if (updated === current) continue;
      files.push({ path: shardPath(key, this.prefix), content: serializeShard(updated) });
    }
    await this.applyShards(files);

    const cached = this.table.get(id);
    if (cached && cached.path === path) this.table.delete(id);
    return files;
  }

  /**
   * Rebuild the whole index from records — the recovery path when a shard is missing or corrupt.
   *
   * Rewrites every shard that differs and drops (or blanks) shards that no longer have terms, so a
   * stale term cannot keep answering queries. The store is left consistent and the files are also
   * returned for a caller that wants to commit them.
   */
  async rebuild(records: readonly CkfRecord[]): Promise<RepoFile[]> {
    const documents = records
      .filter((record) => record.kind !== 'review')
      .map((record) => documentOf(record, this.pathOf(record)));

    const built = new Map<string, PostingsShard>();
    for (const document of documents) {
      for (const [key, entries] of groupTermPostings(document)) {
        built.set(key, addTermPostings(built.get(key) ?? emptyShard(), entries));
      }
    }

    const files: RepoFile[] = [];
    const builtKeys = [...built.keys()].sort(compareText);
    for (const key of builtKeys) {
      const shard = built.get(key);
      if (shard === undefined) continue;
      const content = serializeShard(shard);
      const previous = parseShard(await this.store.readShard(key));
      if (previous !== null && serializeShard(previous) === content) continue;
      files.push({ path: shardPath(key, this.prefix), content });
    }

    for (const key of await this.listShardKeys()) {
      if (built.has(key)) continue;
      if (this.store.removeShard) {
        await this.store.removeShard(key);
        continue;
      }
      const previous = parseShard(await this.store.readShard(key));
      if (previous !== null && Object.keys(previous.terms).length === 0) continue;
      files.push({ path: shardPath(key, this.prefix), content: serializeShard(emptyShard()) });
    }

    await this.applyShards(files);
    this.table.clear();
    for (const document of documents) this.table.set(document.id, document);
    return files;
  }

  /* ---------------------------------------------------------------- *
   * Reads
   * ---------------------------------------------------------------- */

  /** The document table: what this instance indexed, overlaid with the injected cache reader. */
  async documents(): Promise<SearchDocument[]> {
    const merged = new Map<string, SearchDocument>(this.table);
    if (this.externalDocs) {
      for (const document of await this.externalDocs()) merged.set(document.id, document);
    }
    return [...merged.values()];
  }

  /** Shard keys actually present in the store, sorted and de-duplicated. */
  async listShardKeys(): Promise<string[]> {
    const keys = await this.store.listShards();
    return [...new Set(keys)].sort(compareText);
  }

  /**
   * Run a query against the committed shards.
   *
   * Reads every shard up front (they are small and a query rarely touches more than a few), turns an
   * unreadable one into `needsRebuild` rather than an exception, and never throws on a bad query.
   */
  async query(text: string, options: { limit?: number } = {}): Promise<SearchResponse> {
    let keys: string[];
    try {
      keys = await this.listShardKeys();
    } catch {
      // The store itself is unreachable: report "rebuild needed" instead of failing the caller.
      return Object.assign([] as SearchHit[], { needsRebuild: true, terms: [] as string[] });
    }

    const shards: RawShard[] = [];
    // A shard under a key this version does not write was committed by the prefix scheme. Its bytes are
    // valid, so nothing below would notice — but the postings a query needs now live in buckets, so
    // answering from it would silently drop results. Rebuild is the fix, and the UI already offers it.
    let stale = false;
    for (const key of keys) {
      if (!isShardKey(key)) stale = true;
      let content: string | null = null;
      try {
        content = await this.store.readShard(key);
      } catch {
        content = null;
      }
      shards.push({ key, text: content });
    }

    const response = search(shards, text, {
      docs: await this.documents(),
      now: this.now,
      limit: options.limit ?? DEFAULT_LIMIT,
    });
    return stale ? Object.assign(response, { needsRebuild: true }) : response;
  }
}

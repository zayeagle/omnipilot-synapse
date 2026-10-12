/**
 * The sync engine: turn a write-only capture pipeline into a two-way client (F3).
 *
 * Shape of one run:
 *
 *   refresh (ssh only) → read the remote manifest (`index.json`) → diff it against the local cache →
 *   `planMerge` → fetch only what moved → encode + re-index what we changed → **one** commit → record
 *   the outcome.
 *
 * Three decisions are worth stating up front, because they are where this could quietly go wrong:
 *
 * 1. **Change detection does not use the remote head.** The repository's own `index.json` lists every
 *    record with its `content_key`/`updated_at`, so a diff against the cache is both cheaper (one
 *    request) and correct across both transports — the companion has no `compare` API at all.
 * 2. **Pulled records ARE re-indexed, locally.** The index lives on this machine (04-design F16/F17),
 *    so a pull has to compute the postings for what it just received; nothing about them is committed.
 *    Skipping this is how a pulled note became invisible to search.
 * 3. **A path only leaves the dirty set after the commit succeeded.** A rejected push keeps the note
 *    queued (SC-F4-01) instead of pretending it landed.
 */

import type { CkfRecord } from '../core/ckf';
import { VaultLockedError } from '../security/key-session';
import type { SearchIndex } from '../search/index';
import type { ContentCodec, IndexItem } from '../store/codec';
import { indexPath as indexPathFor } from '../core/paths';
import { parseIndex, serializeIndex, type IndexFile } from '../store/tier';
import type { CommitResult, DirEntry, RepoFile } from '../store/types';
import type { SyncOutcome, SyncPolicy, SyncReason } from '../messages';
import type { CachedRecord, SyncCache } from './cache';
import {
  diffRemoteManifest,
  localChanges,
  sameVersion,
  type CacheEntry,
  type ManifestEntry,
} from './manifest';
import { conflictStamp, planMerge, type PathChange } from './reconcile';

/* --------------------------------- remote --------------------------------- */

/** The repository operations one sync needs. Both transports satisfy it; neither is privileged. */
export interface SyncRemote {
  readIndex(): Promise<IndexFile>;
  readFile(path: string): Promise<string | null>;
  listDir(path: string): Promise<DirEntry[]>;
  /**
   * One commit, with optional deletions. A deletion travels as a tree entry whose sha is null (the Git Data
   * API way); a transport that cannot do it must refuse rather than quietly ignoring the paths.
   */
  commitFiles(files: RepoFile[], message: string, deleted?: readonly string[]): Promise<CommitResult>;
  /** Fetch first, so reads see the remote rather than the local working tree (ssh). */
  refresh?(): Promise<unknown>;
}

/** The REST transport: `GitHubStore` already answers these directly. */
export function remoteFromStore(store: {
  readIndex(): Promise<IndexFile>;
  readFile(path: string): Promise<string | null>;
  listDir(path: string): Promise<DirEntry[]>;
  commitFiles(files: RepoFile[], message: string, deleted?: readonly string[]): Promise<CommitResult>;
}): SyncRemote {
  return {
    readIndex: () => store.readIndex(),
    readFile: (path) => store.readFile(path),
    listDir: (path) => store.listDir(path),
    commitFiles: (files, message, deleted) => store.commitFiles(files, message, deleted),
  };
}

/**
 * The companion transport.
 *
 * There is no `readIndex` op — the index is just a file, so it is read through `git.show` and parsed
 * with the same tolerant parser the REST path uses. `refresh` maps onto `git fetch`, which is what
 * makes `origin/<branch>` current before anything is read.
 */
export function remoteFromTransport(
  transport: {
    readFile(path: string): Promise<string | null>;
    listDir(path: string): Promise<DirEntry[]>;
    commitFiles(files: RepoFile[], message: string, deleted?: readonly string[]): Promise<CommitResult>;
    refresh?(): Promise<unknown>;
  },
  prefix?: string | null,
): SyncRemote {
  return {
    readIndex: async () => parseIndex(await transport.readFile(indexPathFor(prefix))),
    readFile: (path) => transport.readFile(path),
    listDir: (path) => transport.listDir(path),
    commitFiles: (files, message, deleted) => transport.commitFiles(files, message, deleted),
    refresh: () => transport.refresh?.() ?? Promise.resolve(),
  };
}

/* ---------------------------------- run ----------------------------------- */

export interface SyncDeps {
  cache: SyncCache;
  index: SearchIndex;
  codec: ContentCodec;
  remote: SyncRemote;
  /** Present only in vault mode; used to refuse caching ciphertext (SC-F5-04). */
  session?: { isUnlocked(at?: number): boolean } | null;
  policy?: SyncPolicy;
  /** Repository path prefix (`github.pathPrefix`). The manifest lives at the prefixed index path. */
  prefix?: string | null;
  now?: () => number;
}

export interface SyncReport {
  outcome: SyncOutcome;
  pulled: number;
  pushed: number;
  removed: number;
  conflicts: string[];
  /** Paths still waiting to be pushed (non-zero only in pull-only mode or after a failure). */
  pending: number;
}

/** The revision identifier recorded in `syncState.head`: the newest manifest timestamp. */
export function manifestHead(entries: readonly ManifestEntry[]): string | null {
  let head: string | null = null;
  for (const entry of entries) {
    if (head === null || entry.updated_at > head) head = entry.updated_at;
  }
  return head;
}

export function manifestEntries(index: IndexFile): ManifestEntry[] {
  return Object.values(index.items).map((item) => ({
    path: item.path,
    id: item.id,
    kind: item.kind,
    updated_at: item.updated_at,
    ...(item.content_key !== undefined ? { content_key: item.content_key } : {}),
  }));
}

export function cacheEntries(records: readonly CachedRecord[]): CacheEntry[] {
  return records.map((record) => ({
    path: record.path,
    id: record.id,
    kind: record.kind,
    // The remote's own timestamp when we know it: comparing our wall clock against the remote's
    // clock would make every pulled record look modified on the next run.
    updatedAt: record.remoteUpdatedAt ?? record.updatedAt,
    ...(record.contentKey !== undefined ? { contentKey: record.contentKey } : {}),
  }));
}

/** Last write wins per path: two encoders can both contribute to the same shard. */
function dedupe(files: readonly RepoFile[]): RepoFile[] {
  const byPath = new Map<string, RepoFile>();
  for (const file of files) byPath.set(file.path, file);
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function commitMessage(report: Omit<SyncReport, 'outcome' | 'pending'>, reason: SyncReason): string {
  const parts = [`sync(${reason})`];
  if (report.pulled > 0) parts.push(`${report.pulled} pulled`);
  if (report.pushed > 0) parts.push(`${report.pushed} pushed`);
  if (report.removed > 0) parts.push(`${report.removed} removed`);
  if (report.conflicts.length > 0) parts.push(`${report.conflicts.length} conflict(s)`);
  return parts.join(' · ');
}

export async function runSync(deps: SyncDeps, reason: SyncReason): Promise<SyncReport> {
  const now = deps.now ?? Date.now;
  const pullOnly = deps.policy?.pullOnly === true;
  // One clock reading for the whole run, so the conflict-copy path and its index id carry the same
  // stamp — two names for the same copy must never be derived from two different minutes.
  const at = now();

  // SC-F5-04: refuse before anything is fetched or cached. Caching ciphertext as if it were a record
  // would make a locked vault look like data loss on the next unlock.
  if (deps.codec.mode === 'vault' && deps.session && !deps.session.isUnlocked(at)) {
    throw new VaultLockedError('sync: unlock the vault before reconciling an encrypted store');
  }

  await deps.remote.refresh?.();

  const remoteIndex = await deps.remote.readIndex();
  const cached = await deps.cache.all();
  const dirty = await deps.cache.dirty();
  const manifest = manifestEntries(remoteIndex);
  const entries = cacheEntries(cached);
  const manifestByPath = new Map(manifest.map((entry) => [entry.path, entry]));
  const cachedByPath = new Map(cached.map((record) => [record.path, record]));

  const diff = diffRemoteManifest(manifest, entries);
  // A remote *deletion* is a remote change too. Passing only the added/modified half would leave the
  // deleted paths in the cache forever, and would hide the resurrect case from `planMerge`.
  const remoteChanges: PathChange[] = [
    ...diff.remote,
    ...diff.deletedRemotely.map((path): PathChange => ({ path, kind: 'deleted' })),
  ];
  const plan = planMerge({ local: localChanges(dirty, entries), remote: remoteChanges, now: () => at });

  const nextIndex: IndexFile = { ...remoteIndex, items: { ...remoteIndex.items } };
  const files: RepoFile[] = [];
  const pulled: string[] = [];
  const pushedPaths: string[] = [];
  let pushed = 0;
  let removed = 0;

  /* ------------------------------- pull ------------------------------- */

  for (const path of plan.pull) {
    const text = await deps.remote.readFile(path);
    // Deleted between the manifest read and the fetch: the next run's diff will drop it.
    if (text === null) continue;
    const record = await deps.codec.decode(text);
    const source = manifestByPath.get(path);
    await deps.cache.put(record, {
      path,
      sha: source?.content_key ?? '',
      ...(source?.content_key !== undefined ? { contentKey: source.content_key } : {}),
      ...(source !== undefined ? { remoteUpdatedAt: source.updated_at } : {}),
    });
    // The index is this machine's, so what this run pulled has to be indexed by this run: it is the
    // only place that knows the record arrived, and a query answers from the local index.
    await deps.index.upsert(record);
    pulled.push(path);
  }

  /* ------------------------------ remove ------------------------------ */

  for (const path of plan.removeLocal) {
    const local = cachedByPath.get(path);
    await deps.cache.forget(path);
    if (local) {
      // Local write, no files: nothing about the index is committed any more.
      await deps.index.remove(local.id, path, local.record);
      delete nextIndex.items[local.id];
    }
    removed += 1;
  }

  /* ------------------------------- push ------------------------------- */

  if (!pullOnly) {
    // `plan.push` holds the paths to *write*, which for a conflict is the copy — while the record we
    // have in hand lives at the original path. This map is what keeps those two from being confused.
    const sourceOf = new Map(plan.conflicts.map((conflict) => [conflict.conflictPath, conflict.path]));
    for (const target of plan.push) {
      const sourcePath = sourceOf.get(target) ?? target;
      const local = cachedByPath.get(sourcePath);
      // A dirty path with no cached record cannot be encoded (the record was never captured here).
      if (local === undefined) {
        pushedPaths.push(sourcePath);
        continue;
      }
      const entry = manifestByPath.get(sourcePath);
      const isConflict = sourceOf.has(target);
      if (
        !isConflict &&
        entry !== undefined &&
        sameVersion(entry, {
          path: sourcePath,
          id: local.id,
          kind: local.kind,
          updatedAt: local.remoteUpdatedAt ?? local.updatedAt,
        })
      ) {
        // The remote already carries this version (the capture path committed it): nothing to write,
        // but the path has stopped being dirty.
        pushedPaths.push(sourcePath);
        continue;
      }
      const content = await deps.codec.encode(local.record);
      files.push({ path: target, content });
      // Indexed on this machine in the same run that pushes it, so the note is findable immediately -
      // whether or not the push lands.
      await deps.index.upsert(local.record);
      const base: IndexItem = deps.codec.indexEntry(local.record, target);
      // A conflict copy needs its own id: sharing the original's would make one of the two versions
      // invisible to every reader that resolves the index by id.
      const item: IndexItem = isConflict
        ? { ...base, id: `${local.id}-conflict-${conflictStamp(at)}` }
        : base;
      nextIndex.items[item.id] = item;
      // The dirty key is the original path; that is what must leave the queue.
      pushedPaths.push(sourcePath);
      pushed += 1;
    }
  }

  const report: Omit<SyncReport, 'outcome' | 'pending'> = {
    pulled: pulled.length,
    pushed,
    removed,
    conflicts: plan.conflicts.map((conflict) => conflict.path),
  };

  /* ------------------------------- commit ------------------------------ */

  let head = manifestHead(manifest);
  // The manifest must be committed whenever it changed — a removal changes it without changing any
  // other file, and skipping the commit there would resurrect the deleted path on the next run.
  if (files.length > 0 || removed > 0) {
    // The manifest is part of the same commit as the notes it describes: a reader can never observe a
    // commit whose index disagrees with its files.
    files.push({ path: indexPathFor(deps.prefix ?? null), content: serializeIndex(nextIndex) });
    const commit = await deps.remote.commitFiles(dedupe(files), commitMessage(report, reason));
    head = commit.sha;
  }

  // Only now is it true that those paths are no longer ours to push.
  await deps.cache.clean(pushedPaths);
  const pending = (await deps.cache.dirty()).length;
  // A removal is pull-side work: the remote told us to drop something, nothing of ours moved.
  const pullSide = report.pulled + report.removed;
  const outcome: SyncOutcome =
    report.conflicts.length > 0
      ? 'conflict'
      : pullSide > 0 && report.pushed > 0
        ? 'merged'
        : pullSide > 0
          ? 'pulled'
          : report.pushed > 0
            ? 'pushed'
            : 'upToDate';

  await deps.cache.updateState({
    head,
    lastSyncAt: new Date(now()).toISOString(),
    lastOutcome: outcome,
    conflicts: report.conflicts,
    // The sibling paths are recorded now: the stamp cannot be reconstructed later, and the decision surface has
    // to name the file it is asking about (F4).
    conflictPaths: Object.fromEntries(
      plan.conflicts.map((conflict) => [conflict.path, conflict.conflictPath]),
    ),
    lastError: null,
  });

  return { outcome, ...report, pending };
}

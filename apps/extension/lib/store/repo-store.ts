/**
 * The repository face every caller above the transport uses.
 *
 * `KnowledgeStore` is deliberately minimal — probe, read, list, commit — because that is all a
 * *transport* must provide. Everything above it (capture, distill, the proposal cards, the review
 * queue, the conflict decision) works with **records and the index**, so it needs a slightly richer
 * face: `readIndex`, `readRecord`, `commitRecord`, `findExisting`, `fileUrl`, `listInbox`.
 *
 * `GitHubStore` answers that face over the REST transport. `createRepoStore` produces the SAME face
 * on top of any `KnowledgeStore` + codec — which is what lets SSH mode (a companion running the
 * user's git) serve every caller instead of only the sync engine. One face, one set of semantics,
 * whichever authorization mode the user chose (R7).
 *
 * The index/record logic lives here once and is shared by both, so token mode and SSH mode cannot
 * drift into two dialects of the same storage format.
 */

import type { CkfRecord } from '../core/ckf';
import { indexPath } from '../core/paths';
import type { SecurityMode } from '../messages';
import type { ContentCodec, IndexItem } from './codec';
import { CommitTooLargeError, NotConfiguredError, NotFoundError, PublicRepoError, ScopeError } from './errors';
import {
  findIndexItemByKey,
  indexToFile,
  mergeIndex,
  parseIndex,
  type IndexFile,
} from './tier';
import type { CommitResult, DirEntry, KnowledgeStore, RepoFile, StoreProbe } from './types';

/**
 * Upper bound on one commit, as a guard against a pathological fan-out — NOT a design target.
 *
 * A capture commits the record, the index AND every search shard its terms touch, and shards are keyed
 * by a term's first two characters. That is "a handful" for English and several HUNDRED for Chinese,
 * where nearly every two-character prefix is distinct: at 64 this refused perfectly ordinary captures
 * with `notConfigured`, which read as "storage is not configured" and sent everyone looking in the
 * wrong place. The Git Data API takes hundreds of tree entries; the cost of a big commit is time, and
 * time is the right thing to spend instead of the user's note.
 */
export const MAX_COMMIT_FILES = 512;

/** Matches `inbox/…` whether or not a repository prefix precedes it. */
export const INBOX_SEGMENT = /(?:^|\/)inbox\//u;
export const PENDING_CARD_SEGMENT = /(?:^|\/)cards\/pending\//u;

export interface CommitRecordOptions {
  message?: string;
  /** Pre-fetched index, so a caller doing several reads does not pay for the same request twice. */
  index?: IndexFile;
  /**
   * Files to commit **atomically** with the record — the search shards it changes (T5.7).
   *
   * A commit is the only atomic boundary this system has, so "the note is stored" and "the note can be
   * found" must be the same commit. On a path collision the record and the index win: a shard may
   * never shadow the note it indexes.
   */
  extraFiles?: readonly RepoFile[];
}

export interface CommitRecordResult {
  commit: CommitResult;
  path: string;
  index: IndexFile;
}

/**
 * Commit message for a record.
 *
 * Vault mode deliberately omits the title: the message is stored in the repository's commit history
 * (and in every notification and webhook the host emits), so it must not carry the headline of the
 * page the user captured. Transparent mode keeps the readable message, which is the trade-off the
 * user opted into.
 */
export function defaultCommitMessage(record: CkfRecord, mode: SecurityMode = 'transparent'): string {
  if (mode === 'vault') return `${record.kind}: [${record.id}]`;
  switch (record.kind) {
    case 'source':
      return `capture: ${record.title || record.url} [${record.id}]`;
    case 'card':
      return `distill: ${record.title} [${record.id}]`;
    case 'topic':
      return `topic: ${record.name} [${record.id}]`;
    default:
      return `review: ${record.id}`;
  }
}

/**
 * Segment-aware filter: the repository path may or may not carry a user prefix, and a naive
 * `includes('/inbox/')` check would silently miss the unprefixed case.
 */
export function listIndexByKind(
  index: IndexFile,
  kind: IndexItem['kind'],
  segment: RegExp,
  limit: number,
): IndexItem[] {
  return Object.values(index.items)
    .filter((item) => item.kind === kind && segment.test(item.path))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, Math.max(1, limit));
}

/** Everything above the transport talks to this and nothing narrower. */
export interface RepoStore extends KnowledgeStore {
  readonly contentCodec: ContentCodec;
  /** Fetch first, so reads see the remote rather than the local working tree (ssh only). */
  refresh?(): Promise<unknown>;
  readIndex(): Promise<IndexFile>;
  readRecord(path: string): Promise<CkfRecord>;
  findExisting(urlKey: string, contentKey: string, index?: IndexFile): Promise<IndexItem | null>;
  commitRecord(record: CkfRecord, options?: CommitRecordOptions): Promise<CommitRecordResult>;
  /** Human-openable URL for a stored file, or `''` when the transport has no web URL. */
  fileUrl(path: string): string;
  /** Inbox listing derived from the index, newest first. No content is read. */
  listInbox(limit?: number): Promise<IndexItem[]>;
}

export interface RepoStoreOptions {
  codec: ContentCodec;
  prefix?: string | null;
  /** `owner/repo`, for the human-openable URL; `''` when the transport has none. */
  repoFullName: string;
  branch?: string;
  /** Set once the user accepted writing to a public repository (the companion never reports one). */
  publicRepoAcknowledged?: boolean;
}

/**
 * Wrap a transport in the record/index face.
 *
 * The write gate runs BEFORE encoding, exactly as it does on the REST path, so a blocked or
 * under-scoped credential never causes an encryption pass or a partial commit.
 */
export function createRepoStore(
  knowledge: KnowledgeStore & { refresh?: () => Promise<unknown> },
  options: RepoStoreOptions,
): RepoStore {
  const prefix = options.prefix ?? null;
  const branch = options.branch ?? 'main';
  const acknowledged = options.publicRepoAcknowledged ?? false;

  const readIndex = async (): Promise<IndexFile> => parseIndex(await knowledge.readFile(indexPath(prefix)));

  const probe = async (): Promise<StoreProbe> => {
    const probed = await knowledge.probe();
    if (probed.visibility === 'public' && !acknowledged) {
      return { ...probed, canWrite: false, warning: 'public-repo' };
    }
    return probed;
  };

  const assertWritable = async (): Promise<StoreProbe> => {
    const probed = await probe();
    if (probed.visibility === 'public' && !acknowledged) throw new PublicRepoError();
    if (!probed.canPush) {
      throw new ScopeError('storage: this credential cannot push to this repository');
    }
    return probed;
  };

  const commitFiles = async (files: RepoFile[], message: string): Promise<CommitResult> => {
    if (files.length === 0) throw new NotConfiguredError('storage: refusing an empty commit');
    if (files.length > MAX_COMMIT_FILES) {
      throw new CommitTooLargeError(files.length, MAX_COMMIT_FILES);
    }
    return knowledge.commitFiles(files, message);
  };

  return {
    kind: knowledge.kind,
    contentCodec: options.codec,
    probe,
    ...(knowledge.refresh ? { refresh: () => knowledge.refresh!() } : {}),
    readFile: (path) => knowledge.readFile(path),
    listDir: (path): Promise<DirEntry[]> => knowledge.listDir(path),
    commitFiles,
    readIndex,

    async readRecord(path: string): Promise<CkfRecord> {
      const text = await knowledge.readFile(path);
      if (text === null) throw new NotFoundError(`storage: no record at ${path}`);
      return options.codec.decode(text);
    },

    /**
     * Dedup lookup. `url_key` wins over `content_key` because the same page captured twice is the
     * common case, while identical text from a different page is usually a legitimate second capture.
     */
    async findExisting(urlKey, contentKey, index) {
      const resolved = index ?? (await readIndex());
      return (
        findIndexItemByKey(resolved, 'url_key', urlKey) ??
        findIndexItemByKey(resolved, 'content_key', contentKey)
      );
    },

    async commitRecord(record, recordOptions = {}) {
      await assertWritable();
      const encoded = await options.codec.encodeRecord(record, prefix);
      const current = recordOptions.index ?? (await readIndex());
      const next = mergeIndex(current, [encoded.index]);
      const files: RepoFile[] = [
        { path: encoded.path, content: encoded.content },
        indexToFile(next, prefix),
      ];
      const taken = new Set(files.map((file) => file.path));
      for (const extra of recordOptions.extraFiles ?? []) {
        if (taken.has(extra.path)) continue;
        taken.add(extra.path);
        files.push(extra);
      }
      const commit = await commitFiles(
        files,
        recordOptions.message ?? defaultCommitMessage(record, options.codec.mode),
      );
      return { commit, path: encoded.path, index: next };
    },

    fileUrl(path: string): string {
      if (options.repoFullName.length === 0) return '';
      return `https://github.com/${options.repoFullName}/blob/${branch}/${path}`;
    },

    async listInbox(limit = 20): Promise<IndexItem[]> {
      return listIndexByKind(await readIndex(), 'source', INBOX_SEGMENT, limit);
    },
  };
}

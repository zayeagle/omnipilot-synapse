/**
 * `KnowledgeStore` implemented on top of GitHub.
 *
 * The ONLY authoritative store in this MVP. It adds three things the REST client deliberately does
 * not know about:
 * 1. the public-repository hard block — a probe that reports `public` cannot write unless the user
 *    explicitly acknowledged the risk (SC-F6-02);
 * 2. content-tier handling — every record goes through the selected codec, so the store never
 *    decides on its own whether the repository holds plaintext or ciphertext;
 * 3. atomicity — the record and the updated `index.json` always ride in the SAME commit, so a
 *    capture can never land half-written (SC-F6-01).
 */

import type { CkfRecord } from '../core/ckf';
import { indexPath } from '../core/paths';
import type { SecurityMode } from '../messages';
import type { CryptoProvider } from '../security/crypto-key';
import type { KeySession } from '../security/key-session';
import { selectCodec, emptyIndex, findIndexItem, findIndexItemByKey, indexToFile, mergeIndex, parseIndex, type IndexFile } from './tier';
import type { ContentCodec, IndexItem } from './codec';
import type { VaultKdf } from './vault-codec';
import {
  NotConfiguredError,
  NotFoundError,
  PublicRepoError,
  ScopeError,
} from './errors';
import { createGithubApi, type FetchLike, type GithubApi } from './github-api';
import type { CommitResult, DirEntry, KnowledgeStore, RepoFile, StoreProbe } from './types';

export const MAX_COMMIT_FILES = 64;

/** Matches `inbox/…` whether or not a repository prefix precedes it. */
const INBOX_SEGMENT = /(?:^|\/)inbox\//u;
const PENDING_CARD_SEGMENT = /(?:^|\/)cards\/pending\//u;

export interface GitHubStoreOptions {
  api: GithubApi;
  codec: ContentCodec;
  repoFullName: string;
  branch?: string;
  prefix?: string | null;
  /** Set once the user has explicitly accepted writing to a public repository. */
  publicRepoAcknowledged?: boolean;
  now?: () => number;
}

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
 * page the user captured. Transparent mode keeps the readable message because that is the trade-off
 * the user opted into.
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

export class GitHubStore implements KnowledgeStore {
  readonly kind = 'github' as const;
  private readonly api: GithubApi;
  private readonly codec: ContentCodec;
  private readonly repoFullName: string;
  private readonly branch: string;
  private readonly prefix: string | null;
  private readonly acknowledged: boolean;

  constructor(options: GitHubStoreOptions) {
    this.api = options.api;
    this.codec = options.codec;
    this.repoFullName = options.repoFullName;
    this.branch = options.branch ?? 'main';
    this.prefix = options.prefix ?? null;
    this.acknowledged = options.publicRepoAcknowledged ?? false;
  }

  get contentCodec(): ContentCodec {
    return this.codec;
  }

  /**
   * Human-openable URL for a stored file. Used when a capture was a duplicate, where there is no new
   * commit to link to.
   */
  fileUrl(path: string): string {
    return `https://github.com/${this.repoFullName}/blob/${this.branch}/${path}`;
  }

  /** Repository metadata, with the public-repo block applied. */
  async probe(): Promise<StoreProbe> {
    const probe = await this.api.probeRepo();
    if (probe.visibility === 'public' && !this.acknowledged) {
      return { ...probe, canWrite: false, warning: 'public-repo' };
    }
    return probe;
  }

  /**
   * Gates every write. The probe is intentionally NOT cached: a repository that is flipped to public
   * after the user configured it must stop accepting writes immediately, and one extra request per
   * capture is a cheap price for that.
   */
  async assertWritable(): Promise<StoreProbe> {
    const probe = await this.probe();
    if (probe.visibility === 'public' && !this.acknowledged) throw new PublicRepoError();
    if (!probe.canPush) {
      throw new ScopeError('storage: the token cannot push to this repository');
    }
    return probe;
  }

  readFile(path: string): Promise<string | null> {
    return this.api.readFile(path);
  }

  listDir(path: string): Promise<DirEntry[]> {
    return this.api.listDir(path);
  }

  /**
   * Delegates to the REST client after guarding the file count. `async` on purpose: a rejected
   * promise is the contract here, so a caller's `try/catch` around `await` always sees it.
   */
  async commitFiles(files: RepoFile[], message: string): Promise<CommitResult> {
    if (files.length === 0) throw new NotConfiguredError('storage: refusing an empty commit');
    if (files.length > MAX_COMMIT_FILES) {
      throw new NotConfiguredError(`storage: refusing a commit with ${files.length} files`);
    }
    return this.api.commitFiles(files, message);
  }

  /* ------------------------------ records ------------------------------ */

  async readIndex(): Promise<IndexFile> {
    return parseIndex(await this.api.readFile(indexPath(this.prefix)));
  }

  async readRecord(path: string): Promise<CkfRecord> {
    const text = await this.api.readFile(path);
    if (text === null) throw new NotFoundError(`storage: no record at ${path}`);
    return this.codec.decode(text);
  }

  /**
   * Dedup lookup. `url_key` wins over `content_key` because the same page captured twice is the
   * common case, while identical text from a different page is usually a legitimate second capture.
   */
  async findExisting(
    urlKey: string,
    contentKey: string,
    index?: IndexFile,
  ): Promise<IndexItem | null> {
    const resolved = index ?? (await this.readIndex());
    const byUrl = findIndexItemByKey(resolved, 'url_key', urlKey);
    if (byUrl) return byUrl;
    return findIndexItemByKey(resolved, 'content_key', contentKey);
  }

  async findByUrlKey(urlKey: string, index?: IndexFile): Promise<IndexItem | null> {
    const resolved = index ?? (await this.readIndex());
    return findIndexItemByKey(resolved, 'url_key', urlKey);
  }

  /**
   * Write one record plus the updated index in a single commit (SC-F6-01).
   *
   * Order of operations matters: the write gate runs BEFORE encoding, so a blocked or under-scoped
   * token never causes an encryption pass or a partial commit.
   */
  async commitRecord(
    record: CkfRecord,
    options: CommitRecordOptions = {},
  ): Promise<CommitRecordResult> {
    await this.assertWritable();

    const encoded = await this.codec.encodeRecord(record, this.prefix);
    const current = options.index ?? (await this.readIndex());
    const next = mergeIndex(current, [encoded.index]);

    const files: RepoFile[] = [
      { path: encoded.path, content: encoded.content },
      indexToFile(next, this.prefix),
    ];

    const taken = new Set(files.map((file) => file.path));
    for (const extra of options.extraFiles ?? []) {
      if (taken.has(extra.path)) continue;
      taken.add(extra.path);
      files.push(extra);
    }

    const commit = await this.commitFiles(
      files,
      options.message ?? defaultCommitMessage(record, this.codec.mode),
    );
    return { commit, path: encoded.path, index: next };
  }

  /** Rewrite just the index (used after an out-of-band change, e.g. a confirmed card). */
  async commitIndex(updated: IndexFile, message = 'index: refresh'): Promise<CommitResult> {
    await this.assertWritable();
    return this.commitFiles([indexToFile(updated, this.prefix)], message);
  }

  /** Remove an index entry without touching the record file. */
  async forgetRecord(id: string, message = 'index: drop entry'): Promise<IndexFile> {
    const current = await this.readIndex();
    const item = findIndexItem(current, id);
    if (!item) return current;
    const next: IndexFile = { ...current, items: { ...current.items } };
    delete next.items[id];
    await this.commitFiles([indexToFile(next, this.prefix)], message);
    return next;
  }

  /** Inbox listing derived from the index, newest first. No content is read. */
  async listInbox(limit = 20): Promise<IndexItem[]> {
    return this.listByKind('source', INBOX_SEGMENT, limit);
  }

  /** Newest cards still awaiting confirmation. */
  async listPendingCards(limit = 20): Promise<IndexItem[]> {
    return this.listByKind('card', PENDING_CARD_SEGMENT, limit);
  }

  /**
   * Segment-aware filter: the repository path may or may not carry a user prefix, and a naive
   * `includes('/inbox/')` check would silently miss the unprefixed case.
   */
  private async listByKind(
    kind: IndexItem['kind'],
    segment: RegExp,
    limit: number,
  ): Promise<IndexItem[]> {
    const index = await this.readIndex();
    return Object.values(index.items)
      .filter((item) => item.kind === kind && segment.test(item.path))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, Math.max(1, limit));
  }

  emptyIndex(): IndexFile {
    return emptyIndex();
  }
}

export interface CreateGitHubStoreOptions {
  owner: string;
  repo: string;
  branch: string;
  apiBase: string;
  token: string;
  securityMode: SecurityMode;
  prefix?: string | null;
  publicRepoAcknowledged?: boolean;
  session?: KeySession | null;
  /** Store-wide KDF parameters taken from the vault envelope; required in vault mode. */
  kdf?: VaultKdf | null;
  fetchImpl: FetchLike;
  crypto?: CryptoProvider;
  now?: () => number;
}

/**
 * Wire a store from settings + unlocked secrets.
 *
 * Throws `NotConfiguredError` for a blank token/owner/repo/branch, and `TierConfigError` when vault
 * mode is requested without a store KDF (i.e. before a vault passphrase was ever set).
 */
export function createGitHubStore(options: CreateGitHubStoreOptions): GitHubStore {
  if (!options.token || !options.owner || !options.repo || !options.branch) {
    throw new NotConfiguredError();
  }

  const api = createGithubApi({
    fetchImpl: options.fetchImpl,
    token: options.token,
    owner: options.owner,
    repo: options.repo,
    branch: options.branch,
    ...(options.apiBase ? { apiBase: options.apiBase } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  const codec = selectCodec(options.securityMode, options.session ?? null, options.crypto, {
    kdf: options.kdf ?? null,
    prefix: options.prefix ?? null,
    ...(options.now ? { now: options.now } : {}),
  });

  return new GitHubStore({
    api,
    codec,
    repoFullName: `${options.owner}/${options.repo}`,
    branch: options.branch,
    prefix: options.prefix ?? null,
    publicRepoAcknowledged: options.publicRepoAcknowledged ?? false,
    ...(options.now ? { now: options.now } : {}),
  });
}

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
import type { SecurityMode } from '../messages';
import type { CryptoProvider } from '../security/crypto-key';
import type { KeySession } from '../security/key-session';
import type { ContentCodec, IndexItem } from './codec';
import {
  CommitTooLargeError,
  NotConfiguredError,
  NotFoundError,
  PublicRepoError,
  ScopeError,
} from './errors';
import { createGithubApi, type FetchLike, type GithubApi } from './github-api';
import {
  MAX_COMMIT_FILES,
  PENDING_CARD_SEGMENT,
  createRepoStore,
  listIndexByKind,
  type CommitRecordOptions,
  type CommitRecordResult,
  type RepoStore,
} from './repo-store';
import { emptyIndex, findIndexItem, findIndexItemByKey, indexToFile, selectCodec, type IndexFile } from './tier';
import type { VaultKdf } from './vault-codec';
import type { CommitResult, DirEntry, RepoFile, StoreProbe } from './types';

// These moved to `repo-store.ts`, where the SSH face needs them too. Re-exported so every existing
// importer keeps working: one definition, two transports.
export { MAX_COMMIT_FILES, defaultCommitMessage } from './repo-store';
export type { CommitRecordOptions, CommitRecordResult } from './repo-store';

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


export class GitHubStore implements RepoStore {
  readonly kind = 'github' as const;
  private readonly api: GithubApi;
  private readonly codec: ContentCodec;
  private readonly repoFullName: string;
  private readonly branch: string;
  private readonly prefix: string | null;
  private readonly acknowledged: boolean;
  /**
   * The record/index face, built lazily over THIS store. `createRepoStore` only calls the raw
   * `probe`/`readFile`/`listDir`/`commitFiles` below it, so there is exactly one implementation of the
   * index and record semantics — shared with the SSH transport instead of re-implemented for it (R7).
   */
  private facade: RepoStore | null = null;

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

  private repo(): RepoStore {
    this.facade ??= createRepoStore(this, {
      codec: this.codec,
      prefix: this.prefix,
      repoFullName: this.repoFullName,
      branch: this.branch,
      publicRepoAcknowledged: this.acknowledged,
    });
    return this.facade;
  }

  /**
   * Human-openable URL for a stored file. Used when a capture was a duplicate, where there is no new
   * commit to link to.
   */
  fileUrl(path: string): string {
    return this.repo().fileUrl(path);
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
  async commitFiles(
    files: RepoFile[],
    message: string,
    deleted: readonly string[] = [],
  ): Promise<CommitResult> {
    if (files.length === 0 && deleted.length === 0) {
      throw new NotConfiguredError('storage: refusing an empty commit');
    }
    if (files.length > MAX_COMMIT_FILES) {
      throw new CommitTooLargeError(files.length, MAX_COMMIT_FILES);
    }
    return this.api.commitFiles(files, message, deleted);
  }

  /* ------------------------------ records ------------------------------ */

  readIndex(): Promise<IndexFile> {
    return this.repo().readIndex();
  }

  readRecord(path: string): Promise<CkfRecord> {
    return this.repo().readRecord(path);
  }

  findExisting(
    urlKey: string,
    contentKey: string,
    index?: IndexFile,
  ): Promise<IndexItem | null> {
    return this.repo().findExisting(urlKey, contentKey, index);
  }

  async findByUrlKey(urlKey: string, index?: IndexFile): Promise<IndexItem | null> {
    const resolved = index ?? (await this.readIndex());
    return findIndexItemByKey(resolved, 'url_key', urlKey);
  }

  /** One record plus the updated index in a single commit (SC-F6-01); shared with the SSH face. */
  commitRecord(
    record: CkfRecord,
    options: CommitRecordOptions = {},
  ): Promise<CommitRecordResult> {
    return this.repo().commitRecord(record, options);
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
  listInbox(limit = 20): Promise<IndexItem[]> {
    return this.repo().listInbox(limit);
  }

  /** Newest cards still awaiting confirmation. */
  async listPendingCards(limit = 20): Promise<IndexItem[]> {
    return listIndexByKind(await this.readIndex(), 'card', PENDING_CARD_SEGMENT, limit);
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

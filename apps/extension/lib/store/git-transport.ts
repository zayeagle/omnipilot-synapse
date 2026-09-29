/**
 * `KnowledgeStore` over the companion process — the SSH transport (F1/T1.5).
 *
 * The store contract is transport-agnostic on purpose (`store/types.ts`), so the sync engine and the
 * capture path are identical for both credential modes; only this file knows that the bytes travel
 * through the user's own `git`.
 *
 * Three properties are worth stating because they are easy to lose:
 * 1. **Reads target the remote-tracking ref** (`origin/<branch>`). A pull must see what the *remote*
 *    has, not what the local working tree happens to contain, so callers run {@link refresh} first.
 * 2. **A missing file is `null`, not an error.** On a first pull most paths are absent from the clone;
 *    the companion reports `notFound` and that is a normal answer.
 * 3. **A write is not durable until the push succeeds.** `commitFiles` commits locally and then
 *    pushes; if the push is rejected the caller gets a `ConflictError` and must keep the paths dirty,
 *    which is what makes "a temporary failure leaves it queued" (SC-F4-01) true rather than hopeful.
 */

import { probeFromCompanion } from '../auth/ssh-auth';
import { NativeError, type NativeClient } from '../native/client';
import {
  asGitLs,
  asGitProbe,
  asGitShow,
  type GitFetchData,
  type GitPushData,
  type NativeOp,
} from '../native/protocol';
import {
  AuthError,
  ConflictError,
  NetworkError,
  NotConfiguredError,
  NotFoundError,
  StoreError,
  TimeoutError,
} from './errors';
import type { CommitResult, DirEntry, KnowledgeStore, RepoFile, StoreProbe } from './types';

export interface GitTransportOptions {
  native: NativeClient;
  /** Absolute path of the user's local clone. The companion confines every operation to it. */
  repoRoot: string;
  branch: string;
  /** `owner/repo`, used only for human-facing links. */
  repoFullName?: string;
  /** Remote name the branch is tracked on. */
  remote?: string;
  now?: () => number;
}

export interface GitWriteData {
  sha: string;
  paths: string[];
}

/**
 * Translate a companion failure into the store's error vocabulary.
 *
 * The distinction that matters: `gitFailed` and `nonFastForward` are **not** network problems. Telling
 * a user with a dirty clone that "the network request failed" sends them debugging the wrong thing.
 */
export function toStoreError(error: unknown): StoreError {
  if (error instanceof StoreError) return error;
  if (error instanceof NativeError) {
    switch (error.code) {
      case 'nativeUnavailable':
      case 'protocolMismatch':
      case 'gitMissing':
      case 'notConfigured':
        return new NotConfiguredError(error.message);
      case 'notFound':
        return new NotFoundError(error.message);
      case 'nonFastForward':
        return new ConflictError(error.message);
      case 'timeout':
        return new TimeoutError(error.message);
      case 'pathOutsideRoot':
        return new AuthError(error.message);
      default:
        return new NetworkError(error.message);
    }
  }
  return new NetworkError(error instanceof Error ? error.message : 'storage: companion call failed');
}

export class GitTransportStore implements KnowledgeStore {
  readonly kind = 'github' as const;

  constructor(private readonly options: GitTransportOptions) {}

  /** The revision reads are taken from: the remote-tracking branch, refreshed by {@link refresh}. */
  get rev(): string {
    return `${this.options.remote ?? 'origin'}/${this.options.branch}`;
  }

  private async send<T>(op: NativeOp, args?: Record<string, unknown>): Promise<T> {
    try {
      return await this.options.native.send<T>(op, {
        cwd: this.options.repoRoot,
        ...(args !== undefined ? { args } : {}),
      });
    } catch (error) {
      throw toStoreError(error);
    }
  }

  /** Fetch the remote so {@link rev} is current. Returns the companion's ahead/behind report. */
  async refresh(): Promise<GitFetchData> {
    return this.send<GitFetchData>('git.fetch');
  }

  async probe(): Promise<StoreProbe> {
    const raw = await this.send('git.probe');
    const info = asGitProbe(raw);
    if (!info) throw new NetworkError('storage: the companion returned an unusable repository probe');
    return {
      ...probeFromCompanion(info, this.options.repoFullName ?? ''),
      checkedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
    };
  }

  async readFile(path: string): Promise<string | null> {
    return await this.withNotFoundNull(async () => {
      const raw = await this.send('git.show', { rev: this.rev, path });
      const data = asGitShow(raw);
      if (!data) throw new NetworkError('storage: the companion returned an unusable file body');
      return data.content;
    });
  }

  /** `notFound` means "the remote does not have this path", which callers express as `null`. */
  private async withNotFoundNull<T>(run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const raw = await this.send('git.ls', { rev: this.rev, dir: path.length === 0 ? null : path });
    const data = asGitLs(raw);
    if (!data) throw new NetworkError('storage: the companion returned an unusable listing');
    return data.entries.map((entry) => ({
      name: entry.path.slice(entry.path.lastIndexOf('/') + 1),
      path: entry.path,
      sha: entry.sha,
      type: entry.type === 'tree' ? 'dir' : 'file',
    }));
  }

  /**
   * Write, commit and push — in that order, because the order is the recovery story.
   *
   * A rejected push leaves a local commit that the next run re-sends (the companion's write is
   * idempotent, so re-writing the same bytes produces no second commit), and the caller's dirty set
   * is only cleared once this promise resolves.
   */
  async commitFiles(files: RepoFile[], message: string): Promise<CommitResult> {
    if (files.length === 0) throw new NotConfiguredError('storage: refusing an empty commit');
    const written = await this.send<GitWriteData>('git.write', {
      message,
      files: files.map((file) => ({ path: file.path, content: file.content })),
    });
    const pushed = await this.send<GitPushData>('git.push', { branch: this.options.branch });
    const repo = this.options.repoFullName ?? '';
    return {
      sha: pushed.head.length > 0 ? pushed.head : written.sha,
      htmlUrl: repo ? `https://github.com/${repo}/commit/${written.sha}` : '',
      paths: written.paths.length > 0 ? written.paths : files.map((file) => file.path),
    };
  }
}

export function createGitTransportStore(options: GitTransportOptions): GitTransportStore {
  return new GitTransportStore(options);
}

/**
 * The storage adapter contract.
 *
 * GitHub is the only implementation in this MVP (requirement: "存储仅支持上传到 github"), but the
 * extension never talks to GitHub directly — it talks to this interface. That is what keeps the
 * deferred GitLab/Gitee/self-hosted-DB/local-filesystem adapters a new file rather than a rewrite.
 */

import type { ErrorCode } from '../messages';

export interface RepoRef {
  owner: string;
  repo: string;
  branch: string;
}

export type RepoVisibility = 'private' | 'internal' | 'public' | 'unknown';

export interface StoreProbe {
  kind: 'github';
  repoFullName: string;
  visibility: RepoVisibility;
  defaultBranch: string;
  /** The token may write to this repository. */
  canPush: boolean;
  /** Writing is actually permitted right now: canPush and not an unacknowledged public repo. */
  canWrite: boolean;
  warning?: 'public-repo';
  checkedAt: string;
}

export interface RepoFile {
  path: string;
  content: string;
}

export interface CommitResult {
  sha: string;
  htmlUrl: string;
  paths: string[];
}

export interface DirEntry {
  name: string;
  path: string;
  sha: string;
  type: 'file' | 'dir';
}

export interface StoreErrorShape {
  code: ErrorCode;
}

export interface KnowledgeStore {
  readonly kind: 'github';
  probe(): Promise<StoreProbe>;
  readFile(path: string): Promise<string | null>;
  listDir(path: string): Promise<DirEntry[]>;
  /** One atomic commit for every file — a capture must never land half-written (SC-F6-01). */
  commitFiles(files: RepoFile[], message: string): Promise<CommitResult>;
}

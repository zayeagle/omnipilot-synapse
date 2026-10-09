/**
 * The GitHub REST client (F6, steps 1–2).
 *
 * This is the only module in the extension that speaks HTTP to a Git host, and it deliberately
 * knows nothing about the CKF, the codec or `index.json` — that is `github-store.ts`'s job. Keeping
 * the boundary here is what makes a Gitea/GitLab sibling a new file instead of a rewrite.
 *
 * Two rules hold everywhere below:
 * - `fetch` is injected, never taken from the global scope, so the client is fully testable and the
 *   background worker stays the only place that owns the network transport;
 * - no raw response body ever reaches a thrown message (it may echo the credential), and any
 *   message derived from a transport failure is scrubbed first.
 */

import { mapWithConcurrency } from '../concurrency';
import { base64ToUtf8 } from '../security/base64';
import { scrubError } from '../security/redact';
import {
  ConflictError,
  NetworkError,
  NotFoundError,
  NotConfiguredError,
  StoreError,
  TimeoutError,
  classifyHttpStatus,
} from './errors';
import type { CommitResult, DirEntry, RepoFile, RepoVisibility, StoreProbe } from './types';

export const DEFAULT_API_BASE = 'https://api.github.com';
export const GITHUB_ACCEPT = 'application/vnd.github+json';
export const GITHUB_API_VERSION = '2022-11-28';
export const DEFAULT_TIMEOUT_MS = 15_000;
/** One backoff retry, not a retry loop: a 5xx that repeats is an outage, not a hiccup. */
export const RETRY_BACKOFF_MS = 400;
/**
 * How many blobs of one commit may be created at once.
 *
 * A capture commits its record, the manifest and every shard its terms touch. Shards are bucketed, so
 * that is at most 258 files for a page in any script — but a blob per file is still the only shape the
 * Git Data API offers, and the capture is the latency-critical path. One at a time turned a full commit
 * into a minute of round trips; twelve lands it in about two seconds.
 *
 * Not higher on purpose: the host asks for serial requests and its secondary limit is aimed at bursts,
 * and 258 requests per capture already sits well inside the 5000-per-hour budget.
 */
const BLOB_UPLOAD_CONCURRENCY = 12;

/** The injected transport. Structurally `fetch`, so `createGithubApi({ fetchImpl: fetch })` works. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GithubApiOptions {
  fetchImpl: FetchLike;
  token: string;
  owner: string;
  repo: string;
  branch: string;
  /** Defaults to `https://api.github.com`; a real setting so a stub or a self-hosted host can be used. */
  apiBase?: string;
  now?: () => number;
  timeoutMs?: number;
}

export interface GithubApi {
  probeRepo(): Promise<StoreProbe>;
  readFile(path: string): Promise<string | null>;
  listDir(path: string): Promise<DirEntry[]>;
  commitFiles(files: RepoFile[], message: string, deleted?: readonly string[]): Promise<CommitResult>;
}

interface HttpOutcome {
  status: number;
  body: unknown;
}

/** `sha: null` is how the Git Data API removes a path: the entry is dropped from the new tree. */
interface TreeEntry {
  path: string;
  mode: '100644';
  type: 'blob';
  sha: string | null;
}

/**
 * Internal sentinel around a ref conflict.
 *
 * Only the final `PATCH` may trigger the whole-sequence retry (design F6 step 4), so the conflict
 * is tagged at its origin instead of being inferred from the error class at the top level.
 */
class RefMovedError extends Error {
  readonly conflict: ConflictError;

  constructor(conflict: ConflictError) {
    super(conflict.message);
    this.name = 'RefMovedError';
    this.conflict = conflict;
  }
}

export function createGithubApi(options: GithubApiOptions): GithubApi {
  const fetchImpl = options.fetchImpl;
  const token = options.token ?? '';
  const owner = (options.owner ?? '').trim();
  const repo = (options.repo ?? '').trim();
  const branch = (options.branch ?? '').trim();
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/u, '');
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const secrets: string[] = [token];
  const repoFullName = `${owner}/${repo}`;

  function assertConfigured(): void {
    if (owner.length === 0 || repo.length === 0 || branch.length === 0 || token.trim().length === 0) {
      throw new NotConfiguredError(
        'storage: owner, repository, branch and a personal access token must all be set',
      );
    }
  }

  function repoUrl(suffix: string): string {
    return `${apiBase}/repos/${owner}/${repo}${suffix}`;
  }

  function contentUrl(path: string): string {
    const encoded = encodePath(path);
    return `${repoUrl('/contents')}${encoded.length > 0 ? `/${encoded}` : ''}?ref=${encodeURIComponent(branch)}`;
  }

  function headers(hasBody: boolean): Record<string, string> {
    const out: Record<string, string> = {
      Accept: GITHUB_ACCEPT,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    };
    // An absent token is a legitimate anonymous request (a public repo on a self-hosted host).
    if (token.trim().length > 0) out['Authorization'] = `Bearer ${token}`;
    if (hasBody) out['Content-Type'] = 'application/json';
    return out;
  }

  /** One HTTP round trip: timeout, transport mapping, body decode. Never inspects status policy. */
  async function sendOnce(method: string, url: string, body?: unknown): Promise<HttpOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const init: RequestInit = {
      method,
      headers: headers(body !== undefined),
      signal: controller.signal,
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(url, init);
      text = await response.text();
    } catch (error) {
      // Our own abort is a timeout; anything else is a transport failure. A transport message may
      // quote the request, so it is scrubbed before it can travel any further.
      if (controller.signal.aborted) throw new TimeoutError();
      throw new NetworkError(scrubError(error, secrets));
    } finally {
      clearTimeout(timer);
    }
    return { status: response.status, body: parseJson(text) };
  }

  /** `sendOnce` plus the retry policy: one backoff retry on 429/5xx, and error classification. */
  async function send(method: string, url: string, body?: unknown): Promise<HttpOutcome> {
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await sendOnce(method, url, body);
      if (outcome.status >= 200 && outcome.status < 300) return outcome;
      const transient = outcome.status === 429 || outcome.status >= 500;
      if (!transient || attempt >= 1) throw classifyHttpStatus(outcome.status, outcome.body);
      await sleep(RETRY_BACKOFF_MS * (attempt + 1));
    }
  }

  async function probeRepo(): Promise<StoreProbe> {
    assertConfigured();
    const outcome = await send('GET', repoUrl(''));
    const body = asRecord(outcome.body);
    const visibility = resolveVisibility(body);
    const canPush = asRecord(body['permissions'])['push'] === true;
    const defaultBranch = body['default_branch'];
    const probe: StoreProbe = {
      kind: 'github',
      repoFullName,
      visibility,
      defaultBranch:
        typeof defaultBranch === 'string' && defaultBranch.length > 0 ? defaultBranch : branch,
      canPush,
      // The public-repo hard block. Acknowledgement is the caller's decision, not this layer's.
      canWrite: canPush && visibility !== 'public',
      checkedAt: new Date(now()).toISOString(),
    };
    if (visibility === 'public') probe.warning = 'public-repo';
    return probe;
  }

  async function readFile(path: string): Promise<string | null> {
    assertConfigured();
    let outcome: HttpOutcome;
    try {
      outcome = await send('GET', contentUrl(path));
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
    // A directory listing is not a file: the caller asked for contents and there are none.
    if (Array.isArray(outcome.body)) return null;
    const entry = asRecord(outcome.body);
    const content = entry['content'];
    if (typeof content !== 'string') return null;
    const encoding = entry['encoding'];
    if (encoding === undefined || encoding === 'base64') {
      // GitHub wraps base64 at 60 columns; the decoder is forgiving, but strip anyway.
      return base64ToUtf8(content.replace(/\s+/gu, ''));
    }
    return content;
  }

  async function listDir(path: string): Promise<DirEntry[]> {
    assertConfigured();
    let outcome: HttpOutcome;
    try {
      outcome = await send('GET', contentUrl(path));
    } catch (error) {
      if (error instanceof NotFoundError) return [];
      throw error;
    }
    // A file path has no children — the same "empty directory" answer, without inventing an error.
    if (!Array.isArray(outcome.body)) return [];
    const entries: DirEntry[] = [];
    for (const raw of outcome.body) {
      const item = asRecord(raw);
      const name = item['name'];
      const itemPath = item['path'];
      const sha = item['sha'];
      const type = item['type'];
      if (typeof name !== 'string' || typeof itemPath !== 'string' || typeof sha !== 'string') {
        continue;
      }
      if (type !== 'file' && type !== 'dir') continue;
      entries.push({ name, path: itemPath, sha, type });
    }
    return entries;
  }

  /** The Git Data API sequence that lands every file in exactly one commit (SC-F6-01). */
  async function commitOnce(
    files: RepoFile[],
    message: string,
    deleted: readonly string[],
  ): Promise<CommitResult> {
    const refUrl = repoUrl(`/git/ref/heads/${encodePath(branch)}`);
    let headSha: string;
    try {
      headSha = requireSha(asRecord(asRecord((await send('GET', refUrl)).body)['object'])['sha']);
    } catch (error) {
      if (error instanceof NotFoundError) throw branchMissing(branch);
      throw error;
    }

    const commitUrl = repoUrl(`/git/commits/${encodeURIComponent(headSha)}`);
    const baseTreeSha = requireSha(
      asRecord(asRecord((await send('GET', commitUrl)).body)['tree'])['sha'],
    );

    // Blobs do not depend on each other, so they are created concurrently while the tree entries keep
    // the caller's file order (the tree itself is order-insensitive, but a stable order keeps the
    // request log readable and the tests honest).
    const tree: TreeEntry[] = await mapWithConcurrency(
      files,
      BLOB_UPLOAD_CONCURRENCY,
      async (file): Promise<TreeEntry> => {
        const blob = await send('POST', repoUrl('/git/blobs'), {
          content: file.content,
          encoding: 'utf-8',
        });
        return {
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: requireSha(asRecord(blob.body)['sha']),
        };
      },
    );

    // Deletions ride the same tree: a `sha: null` entry removes the path from the new tree. They are
    // listed separately from `files` because a deletion has no blob to create first.
    for (const path of deleted) {
      tree.push({ path, mode: '100644', type: 'blob', sha: null });
    }

    const treeResponse = await send('POST', repoUrl('/git/trees'), { base_tree: baseTreeSha, tree });
    const treeSha = requireSha(asRecord(treeResponse.body)['sha']);

    const commitResponse = await send('POST', repoUrl('/git/commits'), {
      message,
      tree: treeSha,
      parents: [headSha],
    });
    const committed = asRecord(commitResponse.body);
    const commitSha = requireSha(committed['sha']);
    const htmlUrl =
      typeof committed['html_url'] === 'string' && committed['html_url'].length > 0
        ? committed['html_url']
        : fallbackHtmlUrl(apiBase, repoFullName, commitSha);

    try {
      await send('PATCH', repoUrl(`/git/refs/heads/${encodePath(branch)}`), { sha: commitSha });
    } catch (error) {
      // A non-fast-forward update is the one failure the whole sequence can recover from.
      if (error instanceof ConflictError) throw new RefMovedError(error);
      throw error;
    }

    return { sha: commitSha, htmlUrl, paths: [...files.map((file) => file.path), ...deleted] };
  }

  async function commitFiles(
    files: RepoFile[],
    message: string,
    deleted: readonly string[] = [],
  ): Promise<CommitResult> {
    assertConfigured();
    if (!Array.isArray(files)) throw validationError('storage: commitFiles requires an array of files');
    if (files.length === 0 && deleted.length === 0) {
      throw validationError('storage: commitFiles requires at least one change');
    }
    for (const path of deleted) {
      if (typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.includes('..')) {
        throw validationError('storage: a deleted path must be a non-empty repository-relative path');
      }
    }
    for (const file of files) {
      if (typeof file?.path !== 'string' || file.path.length === 0) {
        throw validationError('storage: every committed file needs a non-empty path');
      }
      if (typeof file.content !== 'string') {
        throw validationError(`storage: file "${file.path}" has no string content`);
      }
    }

    try {
      return await commitOnce(files, message, deleted);
    } catch (error) {
      if (!(error instanceof RefMovedError)) throw error;
    }
    // The branch moved under us: re-read the ref (the first step of the sequence) and rebuild the
    // commit on the new head — exactly once. Re-PATCHing the stale sha could never fast-forward.
    try {
      return await commitOnce(files, message, deleted);
    } catch (error) {
      if (error instanceof RefMovedError) throw error.conflict;
      throw error;
    }
  }

  return { probeRepo, readFile, listDir, commitFiles };
}

/* --------------------------------- helpers --------------------------------- */

function encodePath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function parseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A non-JSON body (an HTML proxy error, say) is only useful as a status code — and the text
    // must never be surfaced, because it may quote the request.
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireSha(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new StoreError(
      'UnexpectedError',
      'unknown',
      'storage: GitHub returned an unexpected response shape',
    );
  }
  return value;
}

function resolveVisibility(body: Record<string, unknown>): RepoVisibility {
  // `visibility` is authoritative when present (it is the only field that can say "internal").
  const declared = body['visibility'];
  if (declared === 'private' || declared === 'internal' || declared === 'public') return declared;
  const isPrivate = body['private'];
  if (isPrivate === true) return 'private';
  if (isPrivate === false) return 'public';
  return 'unknown';
}

function branchMissing(branch: string): NotFoundError {
  const wrapped = new NotFoundError(
    `storage: branch "${branch}" does not exist in this repository`,
  );
  // `NotFoundError`'s constructor exposes no `hint`, but `StoreError` has one and the UI renders it.
  Object.assign(wrapped, { hint: `Create the branch "${branch}" or pick an existing one` });
  return wrapped;
}

function validationError(message: string): StoreError {
  // `errors.ts` defines no ValidationError and is out of scope here; reusing `StoreError` with the
  // `validation` code keeps the error vocabulary closed instead of opening a parallel type.
  return new StoreError('UnexpectedError', 'validation', message);
}

function fallbackHtmlUrl(apiBase: string, repoFullName: string, sha: string): string {
  return apiBase === DEFAULT_API_BASE
    ? `https://github.com/${repoFullName}/commit/${sha}`
    : `${apiBase}/repos/${repoFullName}/commits/${sha}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Extension-side mirror of the companion (`apps/git-bridge`) protocol.
 *
 * The wire format itself is native messaging's: `chrome.runtime.connectNative` already frames and
 * parses JSON, so this module only owns the *contract* — the version, the command allow-list, the
 * message shapes and the runtime narrowing of every response.
 *
 * Two rules this file exists to enforce:
 * 1. **No op is sent that is not on the allow-list.** The companion enforces this too; doing it on
 *    both sides means a compromised extension cannot use the companion as a general command runner,
 *    and a compromised companion cannot trick the client into believing an arbitrary op succeeded.
 * 2. **Nothing here can carry key material.** `key.list` returns identifiers; there is deliberately
 *    no operation that reads, exports or transmits a private key.
 */

export const PROTOCOL_VERSION = 1;

/** Maximum frame the companion will accept (native messaging's own limit is 1 MB). */
export const MAX_FRAME_BYTES = 1024 * 1024;

export const ALLOWED_OPS = [
  'ping',
  'repo.info',
  'git.probe',
  'git.status',
  'git.fetch',
  /**
   * Content channel (F2, added 2026-09-29). Without these the companion can drive git but cannot move
   * a note's bytes: `git.commit` only stages paths that already exist in the local clone.
   */
  'git.show',
  'git.ls',
  'git.write',
  'git.commit',
  'git.push',
  'key.list',
] as const;

export type NativeOp = (typeof ALLOWED_OPS)[number];

export const NATIVE_ERROR_CODES = [
  'unknownOp',
  'badRequest',
  'frameTooLarge',
  'pathOutsideRoot',
  'gitMissing',
  'gitFailed',
  /** Absent at that revision — expected on a first pull, so it must not read as a failure. */
  'notFound',
  'notConfigured',
  'nonFastForward',
  'timeout',
  'internal',
] as const;

export type NativeErrorCode = (typeof NATIVE_ERROR_CODES)[number];

export interface NativeRequest {
  v: typeof PROTOCOL_VERSION;
  id: string;
  op: NativeOp;
  /** Repository root the companion must confine every path to. Omitted for `ping`. */
  cwd?: string;
  args?: Record<string, unknown>;
}

export type NativeResponse =
  | { v: number; id: string; ok: true; data: unknown }
  | { v: number; id: string; ok: false; code: NativeErrorCode; message: string };

/* ------------------------------- data shapes ------------------------------ */

export interface PingData {
  protocolVersion: number;
  gitVersion: string;
  platform: string;
  node: string;
}

export interface RepoInfoData {
  root: string;
  branch: string;
  head: string | null;
  remoteUrl: string | null;
  dirty: boolean;
}

export interface GitProbeData extends RepoInfoData {
  reachable: boolean;
  remoteBranchExists: boolean;
}

export interface GitStatusData {
  branch: string;
  head: string | null;
  dirty: string[];
}

export interface GitFetchData {
  head: string;
  ahead: number;
  behind: number;
}

export interface GitCommitData {
  sha: string;
  paths: string[];
}

export interface GitPushData {
  head: string;
  pushed: boolean;
}

export interface GitShowData {
  rev: string;
  path: string;
  content: string;
  bytes: number;
}

export interface GitLsEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  size: number;
}

export interface GitLsData {
  rev: string;
  dir: string;
  entries: GitLsEntry[];
}

export interface KeyListData {
  keys: Array<{ ref: string; comment?: string; type?: string }>;
}

/* ------------------------------- validation ------------------------------- */

export function isAllowedOp(value: unknown): value is NativeOp {
  return typeof value === 'string' && (ALLOWED_OPS as readonly string[]).includes(value);
}

export function isNativeErrorCode(value: unknown): value is NativeErrorCode {
  return typeof value === 'string' && (NATIVE_ERROR_CODES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Classify a raw response from the host port.
 *
 * Anything unrecognised becomes `internal` rather than reaching a caller as `undefined` — a silent
 * `undefined` here would look like "the operation succeeded and returned nothing", which is the most
 * dangerous possible failure mode for a git operation.
 */
export function parseNativeResponse(
  value: unknown,
): { ok: true; data: unknown } | { ok: false; code: NativeErrorCode; message: string } {
  if (!isRecord(value)) {
    return { ok: false, code: 'internal', message: 'native: response was not an object' };
  }
  if (value['ok'] === true) return { ok: true, data: value['data'] };
  if (value['ok'] === false) {
    const code = isNativeErrorCode(value['code']) ? value['code'] : 'internal';
    const message =
      typeof value['message'] === 'string' && value['message'].length > 0
        ? value['message']
        : `native: ${code}`;
    return { ok: false, code, message };
  }
  return { ok: false, code: 'internal', message: 'native: response had no ok flag' };
}

export function buildRequest(
  op: NativeOp,
  options: { id: string; cwd?: string; args?: Record<string, unknown> },
): NativeRequest {
  if (!isAllowedOp(op)) {
    // Unreachable through the typed API; kept because a cast could get here at runtime.
    throw new Error(`native: refusing to send op "${String(op)}"`);
  }
  const request: NativeRequest = { v: PROTOCOL_VERSION, id: options.id, op };
  if (options.cwd !== undefined) request.cwd = options.cwd;
  if (options.args !== undefined) request.args = options.args;
  return request;
}

/** Verify a `ping` payload and report whether this client and that host can talk. */
export function checkHandshake(value: unknown): { compatible: boolean; data: PingData | null } {
  if (!isRecord(value)) return { compatible: false, data: null };
  const protocolVersion = value['protocolVersion'];
  if (typeof protocolVersion !== 'number') return { compatible: false, data: null };
  const data: PingData = {
    protocolVersion,
    gitVersion: typeof value['gitVersion'] === 'string' ? value['gitVersion'] : 'unknown',
    platform: typeof value['platform'] === 'string' ? value['platform'] : 'unknown',
    node: typeof value['node'] === 'string' ? value['node'] : 'unknown',
  };
  return { compatible: protocolVersion === PROTOCOL_VERSION, data };
}

/** Runtime narrowing for each data shape — used by the client before returning a result. */
export function asRepoInfo(value: unknown): RepoInfoData | null {
  if (!isRecord(value)) return null;
  const root = value['root'];
  const branch = value['branch'];
  if (typeof root !== 'string' || typeof branch !== 'string') return null;
  const out: RepoInfoData = {
    root,
    branch,
    head: typeof value['head'] === 'string' ? value['head'] : null,
    remoteUrl: typeof value['remoteUrl'] === 'string' ? value['remoteUrl'] : null,
    dirty: value['dirty'] === true,
  };
  return out;
}

export function asGitProbe(value: unknown): GitProbeData | null {
  const base = asRepoInfo(value);
  if (!base || !isRecord(value)) return null;
  return {
    ...base,
    reachable: value['reachable'] === true,
    remoteBranchExists: value['remoteBranchExists'] === true,
  };
}

export function asGitStatus(value: unknown): GitStatusData | null {
  if (!isRecord(value)) return null;
  const branch = value['branch'];
  if (typeof branch !== 'string') return null;
  const dirty = Array.isArray(value['dirty'])
    ? value['dirty'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    branch,
    head: typeof value['head'] === 'string' ? value['head'] : null,
    dirty,
  };
}

export function asGitFetch(value: unknown): GitFetchData | null {
  if (!isRecord(value)) return null;
  const head = value['head'];
  if (typeof head !== 'string') return null;
  return {
    head,
    ahead: typeof value['ahead'] === 'number' ? value['ahead'] : 0,
    behind: typeof value['behind'] === 'number' ? value['behind'] : 0,
  };
}

export function asGitCommit(value: unknown): GitCommitData | null {
  if (!isRecord(value)) return null;
  const sha = value['sha'];
  if (typeof sha !== 'string') return null;
  return {
    sha,
    paths: Array.isArray(value['paths'])
      ? value['paths'].filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}

export function asGitPush(value: unknown): GitPushData | null {
  if (!isRecord(value)) return null;
  const head = value['head'];
  if (typeof head !== 'string') return null;
  return { head, pushed: value['pushed'] === true };
}

/** Narrow a `git.show` payload. Content is a string or the response is unusable. */
export function asGitShow(value: unknown): GitShowData | null {
  if (!isRecord(value)) return null;
  const rev = value['rev'];
  const path = value['path'];
  const content = value['content'];
  if (typeof rev !== 'string' || typeof path !== 'string' || typeof content !== 'string') return null;
  return {
    rev,
    path,
    content,
    bytes: typeof value['bytes'] === 'number' ? value['bytes'] : content.length,
  };
}

/** Narrow a `git.ls` payload, dropping any entry that is not a blob or tree. */
export function asGitLs(value: unknown): GitLsData | null {
  if (!isRecord(value)) return null;
  const rev = value['rev'];
  if (typeof rev !== 'string') return null;
  const entries: GitLsEntry[] = [];
  const raw = value['entries'];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      const path = entry['path'];
      const sha = entry['sha'];
      if (typeof path !== 'string' || typeof sha !== 'string' || path.length === 0) continue;
      const type = entry['type'] === 'tree' ? 'tree' : 'blob';
      const size = typeof entry['size'] === 'number' ? entry['size'] : 0;
      entries.push({ path, type, sha, size });
    }
  }
  return { rev, dir: typeof value['dir'] === 'string' ? value['dir'] : '', entries };
}

/** Key listings are identifiers only — this narrowing makes that structural, not just conventional. */
export function asKeyList(value: unknown): KeyListData {
  if (!isRecord(value) || !Array.isArray(value['keys'])) return { keys: [] };
  const keys: KeyListData['keys'] = [];
  for (const entry of value['keys']) {
    if (!isRecord(entry)) continue;
    const ref = entry['ref'];
    if (typeof ref !== 'string' || ref.length === 0) continue;
    const item: KeyListData['keys'][number] = { ref };
    if (typeof entry['comment'] === 'string') item.comment = entry['comment'];
    if (typeof entry['type'] === 'string') item.type = entry['type'];
    keys.push(item);
  }
  return { keys };
}

/**
 * Map a companion error onto the extension's protocol error code union.
 *
 * `gitFailed` maps to its **own** code, not `network`: a rejected push, a dirty tree or an SSH auth
 * failure are git problems, and telling the user "network request failed" would send them debugging
 * the wrong thing.
 */
export function nativeCodeToErrorCode(code: NativeErrorCode): string {
  switch (code) {
    case 'unknownOp':
    case 'badRequest':
    case 'frameTooLarge':
      return 'validation';
    case 'pathOutsideRoot':
      return 'auth';
    case 'gitMissing':
    case 'notConfigured':
      return 'notConfigured';
    case 'notFound':
      return 'notFound';
    case 'gitFailed':
      return 'gitFailed';
    case 'nonFastForward':
      return 'conflict';
    case 'timeout':
      return 'timeout';
    default:
      return 'nativeUnavailable';
  }
}

/**
 * Companion-side wire protocol for the native-messaging git bridge.
 *
 * This is the mirror of `apps/extension/lib/native/protocol.ts`; the extension already speaks it.
 * The transport is native messaging: a 4-byte little-endian uint32 payload length followed by that
 * many bytes of UTF-8 JSON, one request at a time, stdout only.
 *
 * The shapes here are structural, not advisory: every value that arrives from the browser is
 * `unknown` until {@link parseRequest} has narrowed it, and every value that leaves is built by
 * {@link okResponse} / {@link errorResponse} so that error text can never echo attacker input.
 */

export const PROTOCOL_VERSION = 1;

/** Native messaging's own ceiling; the bridge refuses anything larger rather than buffering it. */
export const MAX_FRAME_BYTES = 1024 * 1024;

export const ALLOWED_OPS = [
  'ping',
  'repo.info',
  'git.probe',
  'git.status',
  'git.fetch',
  /**
   * Content channel (added 2026-09-29). Without these three the bridge can drive git but cannot move
   * a single byte of a note: `git.commit` only stages paths that already exist in the clone.
   *  - `git.show` reads one file at a revision (pull, incremental index read).
   *  - `git.ls` lists a tree at a revision (directory listings, rebuild).
   *  - `git.write` writes content into the working tree, stages and commits it in one step (push).
   */
  'git.show',
  'git.ls',
  'git.write',
  'git.commit',
  'git.push',
  'key.list',
] as const;

export type NativeOp = (typeof ALLOWED_OPS)[number];

export const ERROR_CODES = [
  'unknownOp',
  'badRequest',
  'frameTooLarge',
  'pathOutsideRoot',
  'gitMissing',
  'gitFailed',
  /** The path is absent at the requested revision — an expected state on a first pull, not a failure. */
  'notFound',
  'notConfigured',
  'nonFastForward',
  'timeout',
  'internal',
] as const;

export type NativeErrorCode = (typeof ERROR_CODES)[number];

/**
 * The only strings the extension will ever see in an error response.
 *
 * Deliberately constant: a message assembled from request data would be an injection surface in the
 * browser and a way to smuggle file contents out. Diagnostics that need detail go to `stderr`.
 */
export const ERROR_MESSAGES: Record<NativeErrorCode, string> = {
  unknownOp: 'operation is not allowed',
  badRequest: 'request is malformed',
  frameTooLarge: 'frame exceeds the maximum size',
  pathOutsideRoot: 'path is outside the allowed root',
  gitMissing: 'git executable was not found',
  gitFailed: 'git command failed',
  notFound: 'path does not exist at the requested revision',
  notConfigured: 'not configured',
  nonFastForward: 'push was rejected as non-fast-forward',
  timeout: 'operation timed out',
  internal: 'internal error',
};

/** Transport-level failure carrying a protocol error code. `detail` is for stderr only. */
export class BridgeError extends Error {
  readonly code: NativeErrorCode;
  readonly detail: string | undefined;

  constructor(code: NativeErrorCode, detail?: string) {
    super(ERROR_MESSAGES[code]);
    this.name = 'BridgeError';
    this.code = code;
    this.detail = detail;
  }
}

export interface NativeRequest {
  v: typeof PROTOCOL_VERSION;
  id: string;
  op: NativeOp;
  /** Absolute path of the repository root the request is confined to. Absent for `ping`. */
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
  /** Repository-relative paths, forward slashes. */
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
  /** Repository-relative, forward slashes. */
  path: string;
  content: string;
  bytes: number;
}

export interface GitLsEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  /** Blob size in bytes; 0 for a tree. */
  size: number;
}

export interface GitLsData {
  rev: string;
  /** Repository-relative directory the listing was scoped to; '' for the repository root. */
  dir: string;
  entries: GitLsEntry[];
}

export interface GitWriteData {
  sha: string;
  paths: string[];
}

export interface KeyListData {
  keys: Array<{ ref: string; comment?: string; type?: string }>;
}

/* --------------------------------- framing -------------------------------- */

export type DecodeResult =
  | { ok: true; value: unknown; consumed: number }
  | {
      ok: false;
      code: NativeErrorCode;
      message: string;
      /**
       * Total bytes this frame occupies (4 when even the length prefix is incomplete). The reader
       * uses it to tell "wait for more bytes" from "this frame is complete but unparsable".
       */
      needed: number;
    };

function fail(code: NativeErrorCode, needed: number): DecodeResult {
  return { ok: false, code, message: ERROR_MESSAGES[code], needed };
}

/**
 * Decode the first frame in `buffer`.
 *
 * Never throws: a short buffer, a truncated payload, oversize length or non-JSON body all come back
 * as a coded result. The declared length is checked against the cap *before* the availability check,
 * so an oversize frame is rejected without materialising it.
 */
export function decodeFrame(buffer: Buffer): DecodeResult {
  if (buffer.length < 4) return fail('badRequest', 4);
  const declared = buffer.readUInt32LE(0);
  const needed = 4 + declared;
  if (declared > MAX_FRAME_BYTES) return fail('frameTooLarge', needed);
  if (buffer.length < needed) return fail('badRequest', needed);
  const payload = buffer.subarray(4, needed);
  try {
    const value: unknown = JSON.parse(payload.toString('utf8'));
    return { ok: true, value, consumed: needed };
  } catch {
    return fail('badRequest', needed);
  }
}

/** Frame a value the way native messaging expects. Throws {@link BridgeError} if it cannot fit. */
export function encodeFrame(value: unknown): Buffer {
  const text = JSON.stringify(value) ?? '';
  const payload = Buffer.from(text, 'utf8');
  if (payload.length > MAX_FRAME_BYTES) throw new BridgeError('frameTooLarge', 'outgoing payload');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/* ------------------------------- validation ------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isAllowedOp(value: unknown): value is NativeOp {
  return typeof value === 'string' && (ALLOWED_OPS as readonly string[]).includes(value);
}

export type ParseResult =
  | { ok: true; request: NativeRequest }
  | { ok: false; code: NativeErrorCode; message: string; id: string };

function badRequest(id: string): ParseResult {
  return { ok: false, code: 'badRequest', message: ERROR_MESSAGES.badRequest, id };
}

function readString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return null;
  return value.includes('\0') ? null : value;
}

/**
 * Narrow an arbitrary decoded frame into a request.
 *
 * Order matters: the id is recovered before the op is judged, so an unallowed op still gets a
 * correlated `unknownOp` response instead of a response the client cannot match to its request.
 * No git process is spawned from anything this function rejects.
 */
export function parseRequest(value: unknown): ParseResult {
  if (!isRecord(value)) return badRequest('');
  const id = readString(value['id'], 256) ?? '';
  if (value['v'] !== PROTOCOL_VERSION) return badRequest(id);
  if (id === '') return badRequest('');
  const op = value['op'];
  if (typeof op !== 'string' || op.length === 0) return badRequest(id);
  if (!isAllowedOp(op)) {
    return { ok: false, code: 'unknownOp', message: ERROR_MESSAGES.unknownOp, id };
  }
  const rawArgs = value['args'];
  if (rawArgs !== undefined && !isRecord(rawArgs)) return badRequest(id);
  const request: NativeRequest = { v: PROTOCOL_VERSION, id, op };
  if (rawArgs !== undefined) request.args = rawArgs;
  if (op === 'ping') {
    const cwd = value['cwd'];
    if (cwd !== undefined) {
      const parsed = readString(cwd, 4096);
      if (parsed === null) return badRequest(id);
      request.cwd = parsed;
    }
    return { ok: true, request };
  }
  const cwd = readString(value['cwd'], 4096);
  if (cwd === null) return badRequest(id);
  request.cwd = cwd;
  return { ok: true, request };
}

export function okResponse(id: string, data: unknown): NativeResponse {
  return { v: PROTOCOL_VERSION, id, ok: true, data };
}

export function errorResponse(id: string, code: NativeErrorCode): NativeResponse {
  return { v: PROTOCOL_VERSION, id, ok: false, code, message: ERROR_MESSAGES[code] };
}

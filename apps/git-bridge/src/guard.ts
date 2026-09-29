/**
 * The privilege boundary.
 *
 * Three independent checks stand between a browser message and the user's `git`:
 * 1. {@link assertOpAllowed} — the op must be on the allow-list (checked twice: in `parseRequest`
 *    and again here, so a future refactor that bypasses the parser still cannot widen the surface).
 * 2. {@link resolveInsideRoot} — every path that reaches `git` is `realpath`ed and proven to live
 *    under the configured root, which also defeats `..` walks and symlinks pointing outward.
 * 3. {@link assertArgsSafe} — the remaining argv fragments are type- and shape-checked, and any
 *    value that `git` would read as an option (leading `-`) is refused rather than passed through.
 *
 * Nothing here spawns a process; it either returns a value that is safe to put in an argv array or
 * throws {@link BridgeError}.
 */

import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { ALLOWED_OPS, BridgeError, type NativeOp } from './protocol.js';

const MAX_MESSAGE_CHARS = 8000;
const MAX_PATH_CHARS = 4096;
const MAX_FILES = 1000;
const MAX_BRANCH_CHARS = 255;
const MAX_REV_CHARS = 200;
/** One note; a record is Markdown, so this is already two orders of magnitude of headroom. */
const MAX_CONTENT_CHARS = 512 * 1024;
/** Everything in one request must still fit one native-messaging frame (~1 MB). */
const MAX_TOTAL_CONTENT_CHARS = 700 * 1024;

/** Short, single-line, control-character-free rendering of untrusted input for stderr only. */
function describe(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80);
}

export function assertOpAllowed(op: unknown): asserts op is NativeOp {
  if (typeof op !== 'string' || !(ALLOWED_OPS as readonly string[]).includes(op)) {
    throw new BridgeError('unknownOp', `op not allowed: ${describe(op)}`);
  }
}

function realpathOrNull(candidate: string): string | null {
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Canonicalise `candidatePath` against `root` and prove containment.
 *
 * A path that does not exist yet is resolved through its nearest existing ancestor and then checked,
 * so `src/new-file.ts` is allowed while `../../etc/passwd` is not. Symlinks are followed before the
 * comparison, so a link inside the root that points outside it is rejected.
 */
export function resolveInsideRoot(root: string, candidatePath: unknown): string {
  if (typeof candidatePath !== 'string' || candidatePath.length === 0) {
    throw new BridgeError('badRequest', 'path must be a non-empty string');
  }
  if (candidatePath.length > MAX_PATH_CHARS) {
    throw new BridgeError('badRequest', 'path is too long');
  }
  if (candidatePath.includes('\0')) {
    throw new BridgeError('badRequest', 'path contains NUL');
  }
  const realRoot = realpathOrNull(root);
  if (realRoot === null) {
    throw new BridgeError('badRequest', `root does not exist: ${describe(root)}`);
  }
  const absolute = path.resolve(realRoot, candidatePath);
  const pending: string[] = [];
  let probe = absolute;
  for (;;) {
    const real = realpathOrNull(probe);
    if (real !== null) {
      // `pending` was filled leaf-first; rebuild the tail onto the canonical ancestor.
      const rebuilt = pending.length === 0 ? real : path.join(real, ...pending.reverse());
      if (!isInside(realRoot, rebuilt)) {
        throw new BridgeError('pathOutsideRoot', `escaped root: ${describe(candidatePath)}`);
      }
      return rebuilt;
    }
    const parent = path.dirname(probe);
    if (parent === probe) {
      throw new BridgeError('pathOutsideRoot', `no existing ancestor: ${describe(candidatePath)}`);
    }
    pending.push(path.basename(probe));
    probe = parent;
  }
}

/** Repository-relative, forward-slashed form of an already-confined absolute path. */
/**
 * Refuse any path inside the repository's git metadata.
 *
 * **Why this is not paranoia**: `git.write` materialises bytes on disk *before* it runs git. A target
 * like `.git/hooks/pre-commit` therefore lands a script that the very next `git commit` executes with
 * the user's privileges — turning "the extension can write notes" into arbitrary code execution.
 * `.git/config` is equally fatal (it can set `core.hooksPath`, `core.sshCommand`, `core.fsmonitor`)
 * and our own probe destroyed a test repository's identity by overwriting it.
 *
 * The check is **lexical and case-insensitive**: paths are already confined to the root, so the only
 * git metadata reachable by a repository-relative path is the root `.git` entry — and Windows would
 * otherwise let `.GIT/hooks/...` through a case-sensitive comparison (verified: it did).
 */
export function assertNotGitMetadata(relativePath: string): void {
  const first = relativePath.split('/')[0] ?? '';
  if (first.toLowerCase() === '.git') {
    throw new BridgeError(
      'pathOutsideRoot',
      `refusing to write inside the git directory: ${describe(relativePath)}`,
    );
  }
}

export function toRepoRelative(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  return relative.split(path.sep).join('/');
}

export interface CommitArgsSafe {
  readonly message: string;
  readonly files: readonly string[];
}

export interface PushArgsSafe {
  readonly branch: string;
}

export interface KeyListArgsSafe {
  /** Requested directory, relative to the configured key directory, or `null` for "the default". */
  readonly dir: string | null;
}

export interface ShowArgsSafe {
  readonly rev: string;
  readonly path: string;
}

export interface LsArgsSafe {
  readonly rev: string;
  /** Repository-relative directory, or `null` for the repository root. */
  readonly dir: string | null;
}

export interface WriteFileSafe {
  readonly path: string;
  readonly content: string;
}

export interface WriteArgsSafe {
  readonly message: string;
  readonly files: readonly WriteFileSafe[];
}

type NoArgsSafe = Record<string, never>;

/**
 * Validate a git revision.
 *
 * A revision is *not* a path, so containment does not apply — but it is still an argv fragment, so it
 * is shape-checked: ASCII only, no leading `-` (which git would read as an option), and no `..`
 * segment (which `rev:path` specifications would otherwise use to climb). Anything exotic a user
 * could name (a branch, `origin/main`, a 40-hex sha, `HEAD~2`) still passes.
 */
function requireRev(value: unknown): string {
  const rev = requireString(value, 'rev', MAX_REV_CHARS);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(rev)) {
    throw new BridgeError('badRequest', `rev has characters git would interpret: ${describe(rev)}`);
  }
  if (rev.split('/').includes('..')) {
    throw new BridgeError('badRequest', `rev contains a parent segment: ${describe(rev)}`);
  }
  return rev;
}

function requireContent(value: unknown): string {
  if (typeof value !== 'string') throw new BridgeError('badRequest', 'content must be a string');
  if (value.length > MAX_CONTENT_CHARS) {
    throw new BridgeError('frameTooLarge', 'file content exceeds the per-file cap');
  }
  return value;
}

function requireString(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) {
    throw new BridgeError('badRequest', `${label} must be a non-empty string`);
  }
  if (value.includes('\0')) throw new BridgeError('badRequest', `${label} contains NUL`);
  return value;
}

/**
 * Validate the argv-shaped arguments for `op`.
 *
 * Path containment is *not* done here (it needs the root); callers pass every returned path through
 * {@link resolveInsideRoot} before it reaches `git`.
 *
 * Overloads give each op its own return type so the dispatcher never has to re-check "did the
 * validator actually enforce that field".
 */
export function assertArgsSafe(op: 'git.commit', args?: Record<string, unknown>): CommitArgsSafe;
export function assertArgsSafe(op: 'git.push', args?: Record<string, unknown>): PushArgsSafe;
export function assertArgsSafe(op: 'git.show', args?: Record<string, unknown>): ShowArgsSafe;
export function assertArgsSafe(op: 'git.ls', args?: Record<string, unknown>): LsArgsSafe;
export function assertArgsSafe(op: 'git.write', args?: Record<string, unknown>): WriteArgsSafe;
export function assertArgsSafe(op: 'key.list', args?: Record<string, unknown>): KeyListArgsSafe;
export function assertArgsSafe(op: NativeOp, args?: Record<string, unknown>): NoArgsSafe;
export function assertArgsSafe(
  op: NativeOp,
  args?: Record<string, unknown>,
): CommitArgsSafe | PushArgsSafe | ShowArgsSafe | LsArgsSafe | WriteArgsSafe | KeyListArgsSafe | NoArgsSafe {
  const safe: Record<string, unknown> = args ?? {};
  switch (op) {
    case 'git.commit': {
      const message = requireString(safe['message'], 'commit message', MAX_MESSAGE_CHARS);
      const rawFiles = safe['files'];
      const files: string[] = [];
      if (rawFiles !== undefined) {
        if (!Array.isArray(rawFiles) || rawFiles.length > MAX_FILES) {
          throw new BridgeError('badRequest', 'files must be an array');
        }
        for (const entry of rawFiles) {
          files.push(requireString(entry, 'file', MAX_PATH_CHARS));
        }
      }
      return { message, files };
    }
    case 'git.push': {
      const branch = requireString(safe['branch'], 'branch', MAX_BRANCH_CHARS);
      // A leading '-' would be read by git as an option; '+' forces, ':' deletes a remote ref.
      if (branch.startsWith('-') || branch.startsWith('+') || branch.startsWith(':')) {
        throw new BridgeError('badRequest', `branch starts with a reserved character: ${describe(branch)}`);
      }
      return { branch };
    }
    case 'git.show': {
      const rev = requireRev(safe['rev']);
      const path = requireString(safe['path'], 'path', MAX_PATH_CHARS);
      return { rev, path };
    }
    case 'git.ls': {
      const rev = requireRev(safe['rev']);
      const rawDir = safe['dir'];
      if (rawDir === undefined || rawDir === '') return { rev, dir: null };
      return { rev, dir: requireString(rawDir, 'dir', MAX_PATH_CHARS) };
    }
    case 'git.write': {
      const message = requireString(safe['message'], 'commit message', MAX_MESSAGE_CHARS);
      const rawFiles = safe['files'];
      if (!Array.isArray(rawFiles) || rawFiles.length === 0 || rawFiles.length > MAX_FILES) {
        throw new BridgeError('badRequest', 'files must be a non-empty array');
      }
      const files: WriteFileSafe[] = [];
      let total = 0;
      for (const entry of rawFiles) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          throw new BridgeError('badRequest', 'each file must be { path, content }');
        }
        const record = entry as Record<string, unknown>;
        const path = requireString(record['path'], 'file path', MAX_PATH_CHARS);
        const content = requireContent(record['content']);
        total += content.length;
        if (total > MAX_TOTAL_CONTENT_CHARS) {
          throw new BridgeError('frameTooLarge', 'total content exceeds the request cap');
        }
        files.push({ path, content });
      }
      return { message, files };
    }
    case 'key.list': {
      const rawDir = safe['dir'];
      if (rawDir === undefined) return { dir: null };
      return { dir: requireString(rawDir, 'dir', MAX_PATH_CHARS) };
    }
    default:
      // ping / repo.info / git.probe / git.status / git.fetch take no arguments; anything the
      // extension adds is ignored rather than trusted.
      return {};
  }
}

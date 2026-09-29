/**
 * The only place this process executes anything.
 *
 * Every git invocation in the bridge goes through {@link runGit}, which calls `execFile` with an
 * argv array and `shell: false`. There is no `exec`, no shell string and no string interpolation
 * into a command line anywhere in this package, so a branch named `evil; rm -rf /` is inert: it is
 * one element of an array that the kernel hands to `git` as a single argument.
 *
 * The environment is rebuilt for every call:
 * - `GIT_TERMINAL_PROMPT=0` so an authentication prompt fails instead of hanging the extension.
 * - `GIT_ASKPASS` / `SSH_ASKPASS` are always removed — the bridge never asks for credentials.
 * - `GIT_SSH_COMMAND` is forwarded when the user has set it, so their own SSH config wins.
 * - `-c core.autocrlf=false -c core.safecrlf=false` is prefixed to every command so a repository
 *   config cannot rewrite line endings under the user's feet.
 */

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BridgeError,
  PROTOCOL_VERSION,
  type GitCommitData,
  type GitFetchData,
  type GitLsData,
  type GitLsEntry,
  type GitProbeData,
  type GitShowData,
  type GitWriteData,
  type GitPushData,
  type GitStatusData,
  type KeyListData,
  type PingData,
  type RepoInfoData,
} from './protocol.js';

const GIT_BINARY = 'git';

/** Configuration forced on every invocation, ahead of the subcommand. */
const BASE_GIT_ARGS = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'] as const;

const LOCAL_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 20_000;
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;
/**
 * A single record is Markdown; this is the point at which the answer would no longer fit one
 * native-messaging frame. Refusing is correct — a silently truncated note is data loss.
 */
const MAX_READ_BYTES = 512 * 1024;

export interface RunGitOptions {
  /** Fail the call after this many milliseconds (`timeout` error code). */
  timeoutMs?: number;
  /** Resolve with the exit code instead of throwing `gitFailed`. */
  allowFailure?: boolean;
}

export interface RunGitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env['GIT_TERMINAL_PROMPT'] = '0';
  delete env['GIT_ASKPASS'];
  delete env['SSH_ASKPASS'];
  const sshCommand = process.env['GIT_SSH_COMMAND'];
  if (typeof sshCommand === 'string' && sshCommand.length > 0) {
    env['GIT_SSH_COMMAND'] = sshCommand;
  } else {
    delete env['GIT_SSH_COMMAND'];
  }
  return env;
}

interface ExecFileFailure {
  code?: number | string | undefined;
  killed?: boolean | undefined;
  signal?: string | null | undefined;
  message?: string | undefined;
}

/**
 * Run one `git` command. The single `execFile` call site in this package.
 *
 * `args` is passed through as an array; nothing in it is ever concatenated into a command line.
 */
export async function runGit(
  args: readonly string[],
  cwd: string,
  options: RunGitOptions = {},
): Promise<RunGitResult> {
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.includes('\0')) {
      throw new BridgeError('internal', 'git argv contained a non-string or NUL');
    }
  }
  const timeoutMs = options.timeoutMs ?? LOCAL_TIMEOUT_MS;
  // A missing working directory makes execFile fail with ENOENT, which is indistinguishable from a
  // missing git binary; check it here so the caller gets `badRequest`, not a misleading `gitMissing`.
  let cwdIsDirectory = false;
  try {
    cwdIsDirectory = statSync(cwd).isDirectory();
  } catch {
    cwdIsDirectory = false;
  }
  if (!cwdIsDirectory) throw new BridgeError('badRequest', `not a directory: ${cwd.slice(0, 120)}`);
  const argv = [...BASE_GIT_ARGS, ...args];
  return await new Promise<RunGitResult>((resolve, reject) => {
    execFile(
      GIT_BINARY,
      argv,
      {
        cwd,
        env: buildEnv(),
        shell: false,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : '';
        const err = typeof stderr === 'string' ? stderr : '';
        if (error === null || error === undefined) {
          resolve({ stdout: out, stderr: err, exitCode: 0 });
          return;
        }
        const failure = error as ExecFileFailure;
        if (failure.code === 'ENOENT') {
          reject(new BridgeError('gitMissing', 'git was not on PATH'));
          return;
        }
        if (failure.killed === true || typeof failure.signal === 'string') {
          reject(new BridgeError('timeout', `git timed out after ${timeoutMs}ms`));
          return;
        }
        const exitCode = typeof failure.code === 'number' ? failure.code : 1;
        if (options.allowFailure === true) {
          resolve({ stdout: out, stderr: err, exitCode });
          return;
        }
        reject(
          new BridgeError(
            'gitFailed',
            `git exited ${exitCode}: ${err.replace(/[\r\n]+/g, ' ').slice(0, 200)}`,
          ),
        );
      },
    );
  });
}

function parseCount(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** `git status --porcelain -z`: `XY path`, NUL-terminated, paths never quoted. */
function parseDirty(output: string): string[] {
  const records = output.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) continue;
    const status = record.slice(0, 2);
    const filePath = record.slice(3);
    if (status.includes('R') || status.includes('C')) {
      // A rename/copy is followed by the original path as its own unprefixed record.
      index += 1;
    }
    if (filePath.length > 0) paths.push(filePath);
  }
  return paths;
}

async function currentBranch(cwd: string): Promise<string> {
  const result = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, { allowFailure: true });
  const branch = result.stdout.trim();
  if (result.exitCode !== 0 || branch.length === 0) return 'HEAD';
  return branch;
}

async function currentHead(cwd: string): Promise<string | null> {
  const result = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd, {
    allowFailure: true,
  });
  const head = result.stdout.trim();
  return result.exitCode === 0 && head.length > 0 ? head : null;
}

async function workTreeRoot(cwd: string): Promise<string | null> {
  const result = await runGit(['rev-parse', '--show-toplevel'], cwd, { allowFailure: true });
  const root = result.stdout.trim();
  return result.exitCode === 0 && root.length > 0 ? root : null;
}

/**
 * Refuse to run a repository operation outside a work tree.
 *
 * Reported as `notConfigured` rather than `gitFailed` on purpose: the extension maps `gitFailed` to
 * a network error, and "this directory is not a repository" is not one.
 */
async function assertWorkTree(cwd: string): Promise<void> {
  const inside = await runGit(['rev-parse', '--is-inside-work-tree'], cwd, { allowFailure: true });
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    throw new BridgeError('notConfigured', `not a git work tree: ${cwd.slice(0, 120)}`);
  }
}

/* ---------------------------------- ops ---------------------------------- */

/** `ping` needs no repository: it only reports that git exists and what it is. */
export async function ping(): Promise<PingData> {
  // A directory that always exists, so this cannot fail for want of a cwd.
  const result = await runGit(['--version'], os.tmpdir(), { timeoutMs: 10_000 });
  const gitVersion = result.stdout.trim();
  return {
    protocolVersion: PROTOCOL_VERSION,
    gitVersion: gitVersion.length > 0 ? gitVersion : 'unknown',
    platform: process.platform,
    node: process.version,
  };
}

export async function repoInfo(cwd: string): Promise<RepoInfoData> {
  await assertWorkTree(cwd);
  const root = (await workTreeRoot(cwd)) ?? cwd;
  const branch = await currentBranch(cwd);
  const head = await currentHead(cwd);
  const remote = await runGit(['config', '--get', 'remote.origin.url'], cwd, { allowFailure: true });
  const remoteUrl = remote.exitCode === 0 ? remote.stdout.trim() : '';
  const porcelain = await runGit(['status', '--porcelain=v1', '-z'], cwd);
  return {
    root,
    branch,
    head,
    remoteUrl: remoteUrl.length > 0 ? remoteUrl : null,
    dirty: parseDirty(porcelain.stdout).length > 0,
  };
}

export async function status(cwd: string): Promise<GitStatusData> {
  await assertWorkTree(cwd);
  const branch = await currentBranch(cwd);
  const head = await currentHead(cwd);
  const porcelain = await runGit(['status', '--porcelain=v1', '-z'], cwd);
  return { branch, head, dirty: parseDirty(porcelain.stdout) };
}

export async function probe(cwd: string): Promise<GitProbeData> {
  const info = await repoInfo(cwd);
  let listed: RunGitResult | null = null;
  try {
    listed = await runGit(['ls-remote', '--heads', 'origin'], cwd, {
      timeoutMs: PROBE_TIMEOUT_MS,
      allowFailure: true,
    });
  } catch (error) {
    // An unreachable or unauthenticated remote is a fact about the repo, not a failed request.
    if (error instanceof BridgeError && error.code === 'timeout') listed = null;
    else throw error;
  }
  const listing = listed;
  const reachable = listing !== null && listing.exitCode === 0;
  const wanted = `refs/heads/${info.branch}`;
  const remoteBranchExists =
    reachable && listing !== null
      ? listing.stdout.split('\n').some((line) => {
          const ref = line.split('\t')[1];
          return ref !== undefined && ref.trim() === wanted;
        })
      : false;
  return { ...info, reachable, remoteBranchExists };
}

export async function fetch(cwd: string): Promise<GitFetchData> {
  await assertWorkTree(cwd);
  await runGit(['fetch', '--no-tags', '--quiet'], cwd, { timeoutMs: NETWORK_TIMEOUT_MS });
  const head = await currentHead(cwd);
  if (head === null) throw new BridgeError('notConfigured', 'repository has no commits yet');
  const upstreamResult = await runGit(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '--verify', '--quiet', '@{upstream}'],
    cwd,
    { allowFailure: true },
  );
  let upstream = upstreamResult.exitCode === 0 ? upstreamResult.stdout.trim() : '';
  if (upstream.length === 0) {
    const candidate = `origin/${await currentBranch(cwd)}`;
    const exists = await runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/${candidate}`], cwd, {
      allowFailure: true,
    });
    if (exists.exitCode !== 0) throw new BridgeError('notConfigured', 'branch has no upstream');
    upstream = candidate;
  }
  const counts = await runGit(['rev-list', '--left-right', '--count', `HEAD...${upstream}`], cwd);
  const [aheadRaw, behindRaw] = counts.stdout.trim().split(/\s+/);
  return { head, ahead: parseCount(aheadRaw), behind: parseCount(behindRaw) };
}

export async function commit(
  cwd: string,
  args: { message: string; files?: readonly string[] },
): Promise<GitCommitData> {
  await assertWorkTree(cwd);
  const files = args.files ?? [];
  if (files.length > 0) await runGit(['add', '--', ...files], cwd);
  // The `--` separator keeps a file name that looks like an option out of git's option parser.
  const commitArgs =
    files.length > 0 ? ['commit', '-m', args.message, '--', ...files] : ['commit', '-m', args.message];
  await runGit(commitArgs, cwd);
  const sha = (await runGit(['rev-parse', 'HEAD'], cwd)).stdout.trim();
  if (files.length > 0) {
    return { sha, paths: files.map((file) => file.split(path.sep).join('/')) };
  }
  const changed = await runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'], cwd);
  return { sha, paths: changed.stdout.split('\0').filter((entry) => entry.length > 0) };
}

/* ------------------------------------------------------------------ *
 * Content channel (F2, added 2026-09-29)
 *
 * These three functions are the only way knowledge content crosses the boundary. They are the
 * companion's whole reason to exist for sync: without them the extension can drive git but cannot
 * move a note's bytes in either direction.
 * ------------------------------------------------------------------ */

/**
 * Read one file at a revision.
 *
 * Absence is reported as `notFound`, never as an empty string: on a first pull "the remote has no
 * such file" and "the file is empty" are different facts and only one of them is an error.
 */
export async function show(cwd: string, args: { rev: string; path: string }): Promise<GitShowData> {
  const spec = `${args.rev}:${args.path}`;
  const exists = await runGit(['cat-file', '-e', spec], cwd, { allowFailure: true });
  if (exists.exitCode !== 0) throw new BridgeError('notFound', `no such object: ${spec}`);
  const result = await runGit(['show', spec], cwd);
  const content = result.stdout;
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_READ_BYTES) {
    throw new BridgeError('frameTooLarge', `object is ${bytes} bytes: ${spec}`);
  }
  return { rev: args.rev, path: args.path, content, bytes };
}

/** List a tree at a revision. `dir === null` lists the repository root, recursively. */
export async function lsTree(
  cwd: string,
  args: { rev: string; dir: string | null },
): Promise<GitLsData> {
  const argv = ['ls-tree', '-r', '-l', '-z', args.rev];
  if (args.dir !== null) argv.push('--', args.dir);
  const result = await runGit(argv, cwd, { allowFailure: true });
  if (result.exitCode !== 0) {
    throw new BridgeError('notFound', `no tree at ${args.rev}`);
  }
  const entries: GitLsEntry[] = [];
  for (const record of result.stdout.split('\0')) {
    if (record.length === 0) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const meta = record.slice(0, tab).trim().split(/\s+/);
    const entryPath = record.slice(tab + 1);
    const sha = meta[2] ?? '';
    if (entryPath.length === 0 || sha.length === 0) continue;
    const size = Number.parseInt(meta[3] ?? '0', 10);
    entries.push({
      path: entryPath,
      type: meta[1] === 'tree' ? 'tree' : 'blob',
      sha,
      size: Number.isFinite(size) ? size : 0,
    });
  }
  return { rev: args.rev, dir: args.dir ?? '', entries };
}

/** One file to materialise. `absolute` is already confined by the dispatcher; re-checked here. */
export interface WriteTarget {
  readonly absolute: string;
  readonly relative: string;
  readonly content: string;
}

/**
 * Write content into the working tree, stage it and commit it — the push path.
 *
 * Every byte here comes from the browser, so the two guarantees are structural: a target must live
 * under `cwd` (checked again even though the dispatcher already resolved it), and the commit is
 * scoped with `--` so a path that looks like an option is inert. No shell, no interpolation.
 */
export async function writeAndCommit(
  cwd: string,
  args: { message: string; files: readonly WriteTarget[] },
): Promise<GitWriteData> {
  await assertWorkTree(cwd);
  if (args.files.length === 0) throw new BridgeError('badRequest', 'no files to write');
  const root = path.resolve(cwd);
  const written: string[] = [];
  for (const file of args.files) {
    const absolute = path.resolve(file.absolute);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) {
      throw new BridgeError('pathOutsideRoot', `write target escaped the root: ${file.relative}`);
    }
    // Defence in depth: the dispatcher also refuses .git, and so does this — a future caller that
    // bypasses the dispatcher (a test, a second entry point) must not be able to install a hook.
    if ((file.relative.split('/')[0] ?? '').toLowerCase() === '.git') {
      throw new BridgeError('pathOutsideRoot', `write target is git metadata: ${file.relative}`);
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content, { encoding: 'utf8', mode: 0o600 });
    written.push(file.relative);
  }
  await runGit(['add', '--', ...written], cwd);
  // Idempotence: a retry after a rejected push must not fail with "nothing to commit", and must not
  // create an empty commit. If the bytes are already in the index, the caller gets the current HEAD.
  const staged = await runGit(['diff', '--cached', '--quiet'], cwd, { allowFailure: true });
  if (staged.exitCode === 0) {
    const head = (await runGit(['rev-parse', 'HEAD'], cwd)).stdout.trim();
    return { sha: head, paths: [] };
  }
  await runGit(['commit', '-m', args.message, '--', ...written], cwd);
  const sha = (await runGit(['rev-parse', 'HEAD'], cwd)).stdout.trim();
  return { sha, paths: written };
}

export async function push(cwd: string, args: { branch: string }): Promise<GitPushData> {
  await assertWorkTree(cwd);
  const result = await runGit(['push', '--porcelain', 'origin', args.branch], cwd, {
    timeoutMs: NETWORK_TIMEOUT_MS,
    allowFailure: true,
  });
  if (result.exitCode !== 0) {
    const rejected =
      /(^|\n)!\t/.test(result.stdout) || /non-fast-forward|\[rejected\]|fetch first/i.test(result.stderr);
    throw new BridgeError(
      rejected ? 'nonFastForward' : 'gitFailed',
      `push exited ${result.exitCode}`,
    );
  }
  const head = (await runGit(['rev-parse', 'HEAD'], cwd)).stdout.trim();
  return { head, pushed: true };
}

/** `id_<type>` prefixes this bridge is willing to name, longest token first. */
const KEY_TYPE_PATTERN = /^id_(ed25519_sk|ecdsa_sk|ed25519|ecdsa|rsa|dsa|xmss)(?:_(.+))?$/;

/**
 * List SSH key *identifiers* by reading directory entries only.
 *
 * No file is ever opened: the ref is the file name minus `.pub`, the type and optional comment come
 * from the name. A private key body, a public key body and any passphrase are all out of reach of
 * this function by construction — which is the point, since the response crosses into the browser.
 */
export async function keyList(dir: string): Promise<KeyListData> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { keys: [] };
  }
  const byRef = new Map<string, KeyListData['keys'][number]>();
  for (const entry of entries) {
    const name = entry.name;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const ref = name.endsWith('.pub') ? name.slice(0, -4) : name;
    const match = KEY_TYPE_PATTERN.exec(ref);
    if (match === null) continue;
    const type = match[1];
    if (type === undefined) continue;
    const item: KeyListData['keys'][number] = { ref, type };
    const comment = match[2];
    if (comment !== undefined && comment.length > 0) item.comment = comment;
    if (!byRef.has(ref)) byRef.set(ref, item);
  }
  return { keys: [...byRef.values()].sort((a, b) => a.ref.localeCompare(b.ref)) };
}

/**
 * Entry point and request dispatcher.
 *
 * The dispatcher is exported as a plain async function so it can be exercised directly in tests
 * without a stdio harness; {@link main} is a thin native-messaging loop around it. The loop holds no
 * long-lived state: one frame in, one response out, and every failure becomes either a coded error
 * frame or a clean `exit(0)`. stdout carries protocol frames only; diagnostics go to stderr.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as git from './git.js';
import {
  assertArgsSafe,
  assertNotGitMetadata,
  assertOpAllowed,
  resolveInsideRoot,
  toRepoRelative,
} from './guard.js';
import {
  BridgeError,
  decodeFrame,
  encodeFrame,
  errorResponse,
  okResponse,
  parseRequest,
  type NativeResponse,
} from './protocol.js';

export interface HandlerOptions {
  /**
   * Root every request path is confined to. It comes from the host configuration (the installer or
   * the launcher), never from a request, so a compromised extension cannot widen it.
   */
  repoRoot: string;
  /**
   * The one directory outside `repoRoot` that may be *listed* (never read) for `key.list`. Absent
   * means the op answers `notConfigured`.
   */
  sshDir?: string;
}

export type RequestHandler = (raw: unknown) => Promise<NativeResponse>;

function log(message: string): void {
  process.stderr.write(`git-bridge: ${message}\n`);
}

function clean(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').slice(0, 200);
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Build the request handler for one configured root.
 *
 * Parsing happens first and rejects every op that is not on the allow-list before any path is
 * resolved, so an unallowed op cannot even be used to probe the filesystem.
 */
export function createHandler(options: HandlerOptions): RequestHandler {
  const sshDir = options.sshDir;
  return async function handle(raw: unknown): Promise<NativeResponse> {
    const parsed = parseRequest(raw);
    if (!parsed.ok) {
      log(`rejected request: ${parsed.code}`);
      return errorResponse(parsed.id, parsed.code);
    }
    const request = parsed.request;
    try {
      assertOpAllowed(request.op);
      if (request.op === 'ping') return okResponse(request.id, await git.ping());
      const root = resolveInsideRoot(options.repoRoot, request.cwd ?? '');
      switch (request.op) {
        case 'repo.info':
          return okResponse(request.id, await git.repoInfo(root));
        case 'git.status':
          return okResponse(request.id, await git.status(root));
        case 'git.probe':
          return okResponse(request.id, await git.probe(root));
        case 'git.fetch':
          return okResponse(request.id, await git.fetch(root));
        case 'git.show': {
          const safe = assertArgsSafe('git.show', request.args);
          // Confine the path, then hand git the *repository-relative* form: `rev:path` is a
          // revision specification, not a filesystem path, so the canonical absolute path would be
          // both wrong and leak the user's home directory into argv.
          const relative = toRepoRelative(root, resolveInsideRoot(root, safe.path));
          return okResponse(request.id, await git.show(root, { rev: safe.rev, path: relative }));
        }
        case 'git.ls': {
          const safe = assertArgsSafe('git.ls', request.args);
          const dir =
            safe.dir === null ? null : toRepoRelative(root, resolveInsideRoot(root, safe.dir));
          return okResponse(request.id, await git.lsTree(root, { rev: safe.rev, dir }));
        }
        case 'git.write': {
          const safe = assertArgsSafe('git.write', request.args);
          const files = safe.files.map((file) => {
            const absolute = resolveInsideRoot(root, file.path);
            const relative = toRepoRelative(root, absolute);
            // A write target must be content, never the repository's own machinery (S4).
            assertNotGitMetadata(relative);
            return { absolute, relative, content: file.content };
          });
          return okResponse(request.id, await git.writeAndCommit(root, { message: safe.message, files }));
        }
        case 'git.commit': {
          const safe = assertArgsSafe('git.commit', request.args);
          // Confine every path (containment only): the original string is what git receives, so a
          // name with spaces, quotes or CJK reaches git byte-for-byte.
          const confined = safe.files.map((file) => resolveInsideRoot(root, file));
          const data = await git.commit(root, { message: safe.message, files: safe.files });
          return okResponse(request.id, {
            sha: data.sha,
            paths: confined.map((file) => toRepoRelative(root, file)),
          });
        }
        case 'git.push': {
          const safe = assertArgsSafe('git.push', request.args);
          return okResponse(request.id, await git.push(root, { branch: safe.branch }));
        }
        case 'key.list': {
          const safe = assertArgsSafe('key.list', request.args);
          if (sshDir === undefined) throw new BridgeError('notConfigured', 'no key directory configured');
          if (!isDirectory(sshDir)) return okResponse(request.id, { keys: [] });
          const dir = safe.dir === null ? sshDir : resolveInsideRoot(sshDir, safe.dir);
          return okResponse(request.id, await git.keyList(dir));
        }
        default:
          return errorResponse(request.id, 'internal');
      }
    } catch (error) {
      if (error instanceof BridgeError) {
        if (error.detail !== undefined) log(`${request.op} → ${error.code}: ${clean(error.detail)}`);
        return errorResponse(request.id, error.code);
      }
      log(`${request.op} → internal: ${clean(String(error))}`);
      return errorResponse(request.id, 'internal');
    }
  };
}

function writeFrame(response: NativeResponse): Promise<void> {
  let frame: Buffer;
  try {
    frame = encodeFrame(response);
  } catch {
    frame = encodeFrame(errorResponse(response.id, 'frameTooLarge'));
  }
  return new Promise<void>((resolve) => {
    process.stdout.write(frame, () => resolve());
  });
}

function asBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
  return Buffer.from(chunk as Uint8Array);
}

async function runStdioLoop(handler: RequestHandler): Promise<void> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, asBuffer(chunk)]);
    for (;;) {
      const frame = decodeFrame(buffer);
      if (!frame.ok && frame.code === 'frameTooLarge') {
        // The stream cannot be trusted to resynchronise from here.
        await writeFrame(errorResponse('', 'frameTooLarge'));
        process.exit(0);
      }
      if (frame.ok) {
        buffer = buffer.subarray(frame.consumed);
        await writeFrame(await handler(frame.value));
        continue;
      }
      if (buffer.length < frame.needed) break; // Incomplete: wait for the rest of the frame.
      buffer = buffer.subarray(frame.needed);
      log(`dropped malformed frame (${frame.needed} bytes)`);
      await writeFrame(errorResponse('', frame.code));
    }
  }
  if (buffer.length > 0) {
    log('input ended mid-frame');
    await writeFrame(errorResponse('', 'badRequest'));
  }
}

function firstNonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function main(): Promise<void> {
  const repoRoot = firstNonEmpty(process.env['OMNIPILOT_REPO_ROOT']) ?? process.cwd();
  const sshDir = firstNonEmpty(process.env['OMNIPILOT_SSH_DIR']) ?? path.join(os.homedir(), '.ssh');
  const handler = createHandler({ repoRoot, sshDir });
  log(`root=${repoRoot}`);
  try {
    await runStdioLoop(handler);
    log('stdin closed');
  } catch (error) {
    log(`loop ended: ${clean(String(error))}`);
  }
  process.exit(0);
}

const entry = process.argv[1];
const invokedDirectly =
  typeof entry === 'string' && entry.length > 0 && import.meta.url === pathToFileURL(entry).href;
if (invokedDirectly) void main();

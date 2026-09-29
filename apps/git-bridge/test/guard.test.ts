import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The whole point of this suite is what does *not* reach the OS: no test here may let a real git
// process run, so child_process is replaced before the module graph is loaded.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertOpAllowed, resolveInsideRoot } from '../src/guard.js';
import { createHandler } from '../src/main.js';
import { BridgeError, ERROR_MESSAGES, PROTOCOL_VERSION } from '../src/protocol.js';

type Reply = { stdout?: string; stderr?: string; error?: Error | null };

const execFileMock = vi.mocked(execFile);

function stubGit(reply: (args: string[]) => Reply): void {
  execFileMock.mockImplementation(((
    _file: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const result = reply([...args]);
    callback(result.error ?? null, result.stdout ?? '', result.stderr ?? '');
    return {} as never;
  }) as never);
}

function defaultReply(args: string[]): Reply {
  if (args.includes('--version')) return { stdout: 'git version 2.54.0\n' };
  // Every repository op first asks whether the cwd is a work tree.
  if (args.includes('--is-inside-work-tree')) return { stdout: 'true\n' };
  if (args.includes('--show-toplevel')) return { stdout: 'C:/work/repo\n' };
  if (args.includes('push')) return { stdout: 'To origin\n' };
  if (args.includes('rev-parse')) return { stdout: 'aaaa1111bbbb2222\n' };
  return { stdout: '' };
}

/** Every argv array the bridge handed to execFile, in order. */
function gitCalls(): Array<{ file: string; args: string[]; options: Record<string, unknown> }> {
  return execFileMock.mock.calls.map((call) => {
    const [file, args, options] = call as unknown as [string, string[], Record<string, unknown>];
    return { file, args: Array.isArray(args) ? [...args] : [], options: options ?? {} };
  });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'no-error';
  } catch (error) {
    return error instanceof BridgeError ? error.code : `unexpected:${String(error)}`;
  }
}

let root = '';
let outsideDir = '';

beforeAll(() => {
  // realpath up front: on Windows the temp dir is handed out as an 8.3 short name.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-bridge-root-')));
  outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-bridge-outside-')));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

beforeEach(() => {
  execFileMock.mockReset();
  stubGit(defaultReply);
});

describe('privilege boundary', () => {
  it('TC-F2-U03 op shell.exec is unknownOp and no child process was ever spawned', async () => {
    expect(codeOf(() => assertOpAllowed('shell.exec'))).toBe('unknownOp');

    const handler = createHandler({ repoRoot: root });
    const response = await handler({ v: PROTOCOL_VERSION, id: 'u03-1', op: 'shell.exec', cwd: root });

    expect(response).toEqual({
      v: PROTOCOL_VERSION,
      id: 'u03-1',
      ok: false,
      code: 'unknownOp',
      message: ERROR_MESSAGES.unknownOp,
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('TC-F2-U04 a .. escape is refused as pathOutsideRoot', async () => {
    expect(codeOf(() => resolveInsideRoot(root, '../outside.txt'))).toBe('pathOutsideRoot');
    expect(codeOf(() => resolveInsideRoot(root, path.join('nested', '..', '..', 'outside.txt')))).toBe(
      'pathOutsideRoot',
    );

    const handler = createHandler({ repoRoot: root });
    const response = await handler({
      v: PROTOCOL_VERSION,
      id: 'u04-1',
      op: 'repo.info',
      cwd: path.join(root, '..'),
    });

    expect(response).toMatchObject({ id: 'u04-1', ok: false, code: 'pathOutsideRoot' });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('TC-F2-U05 an absolute path outside the root is refused as pathOutsideRoot', async () => {
    expect(codeOf(() => resolveInsideRoot(root, outsideDir))).toBe('pathOutsideRoot');
    expect(codeOf(() => resolveInsideRoot(root, path.join(outsideDir, 'x.txt')))).toBe('pathOutsideRoot');

    const handler = createHandler({ repoRoot: root });
    const response = await handler({
      v: PROTOCOL_VERSION,
      id: 'u05-1',
      op: 'git.status',
      cwd: outsideDir,
    });

    expect(response).toMatchObject({ id: 'u05-1', ok: false, code: 'pathOutsideRoot' });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('TC-F2-U06 branch evil; rm -rf / reaches git as ONE argv element and never through a shell', async () => {
    const branch = 'evil; rm -rf /';
    const handler = createHandler({ repoRoot: root });
    const response = await handler({
      v: PROTOCOL_VERSION,
      id: 'u06-1',
      op: 'git.push',
      cwd: root,
      args: { branch },
    });

    expect(response).toMatchObject({ id: 'u06-1', ok: true });

    const calls = execFileMock.mock.calls as unknown as Array<
      [string, string[], Record<string, unknown>]
    >;
    expect(calls.length).toBeGreaterThan(0);
    for (const [cmd, args, opts] of calls) {
      expect(cmd).toBe('git');
      expect(Array.isArray(args)).toBe(true);
      expect(opts['shell'] !== true).toBe(true);
      expect(opts['shell']).toBe(false);
    }

    const pushCall = calls.find(([, args]) => args.includes('push'));
    expect(pushCall).toBeDefined();
    const argsArray = pushCall?.[1] ?? [];
    // The inert-argument claim, asserted literally:
    expect(argsArray).toContain(branch);
    expect(argsArray[argsArray.length - 1]).toBe(branch);
    expect(argsArray.filter((arg) => arg === branch)).toHaveLength(1);
    expect(argsArray).not.toContain('rm');
    expect(argsArray).not.toContain('evil;');
  });

  it('TC-F2-U08 a path with spaces, quotes and CJK survives verbatim', async () => {
    const weird = 'sp ace "q" 中文.txt';
    const message = 'commit; $(rm -rf /) `x`';

    expect(resolveInsideRoot(root, weird)).toBe(path.join(root, weird));

    const handler = createHandler({ repoRoot: root });
    const response = await handler({
      v: PROTOCOL_VERSION,
      id: 'u08-1',
      op: 'git.commit',
      cwd: root,
      args: { message, files: [weird] },
    });

    expect(response).toMatchObject({ id: 'u08-1', ok: true, data: { paths: [weird] } });

    const add = gitCalls().find((call) => call.args.includes('add'));
    expect(add).toBeDefined();
    expect(add?.args).toContain(weird);
    expect(add?.args[add?.args.length - 1]).toBe(weird);
    expect(add?.options['shell']).toBe(false);

    const commitCall = gitCalls().find((call) => call.args.includes('commit'));
    expect(commitCall?.args).toContain('--');
    expect(commitCall?.args).toContain(weird);
    expect(commitCall?.args).toContain(message);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * TC-F2-S01…S08 — the companion as a **process**.
 *
 * Everything else in this package is tested by calling functions; this suite is the only one that
 * spawns `dist/main.js`, speaks the 4-byte-framed native-messaging protocol over real stdio, and lets
 * a real `git` talk to a real bare remote. That is the only way to test the framing, the exit
 * behaviour and the confinement end to end — the seams that quietly rot when only units are tested.
 *
 * Run with `npm run test:sys` (it builds first).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeEntry = path.resolve(here, '..', '..', 'dist', 'main.js');

interface Frame {
  v: number;
  id: string;
  ok: boolean;
  data?: unknown;
  code?: string;
  message?: string;
}

interface Bridge {
  send(op: string, args?: Record<string, unknown>, cwd?: string): Promise<Frame>;
  raw(bytes: Buffer): void;
  next(): Promise<Frame>;
  alive(): boolean;
  stop(): void;
}

function frameOf(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function startBridge(root: string, sshDir: string): Bridge {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [bridgeEntry], {
    env: { ...process.env, OMNIPILOT_REPO_ROOT: root, OMNIPILOT_SSH_DIR: sshDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = Buffer.alloc(0);
  const byId = new Map<string, (frame: Frame) => void>();
  const queue: Array<(frame: Frame) => void> = [];
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  // stderr is diagnostics only and must never be part of the protocol.
  child.stderr.on('data', () => undefined);
  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 4) return;
      const declared = buffer.readUInt32LE(0);
      if (buffer.length < 4 + declared) return;
      const frame = JSON.parse(buffer.subarray(4, 4 + declared).toString('utf8')) as Frame;
      buffer = buffer.subarray(4 + declared);
      const waiter = byId.get(frame.id);
      if (waiter) {
        byId.delete(frame.id);
        waiter(frame);
        continue;
      }
      const anyWaiter = queue.shift();
      if (anyWaiter) anyWaiter(frame);
    }
  });

  let seq = 0;
  return {
    send(op, args, cwd) {
      const id = `s${++seq}`;
      return new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => {
          byId.delete(id);
          reject(new Error(`no answer for ${op} within 20s`));
        }, 20_000);
        byId.set(id, (frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
        child.stdin.write(
          frameOf({ v: 1, id, op, cwd: cwd ?? root, ...(args ? { args } : {}) }),
        );
      });
    },
    raw(bytes) {
      child.stdin.write(bytes);
    },
    next() {
      return new Promise<Frame>((resolve) => queue.push(resolve));
    },
    alive: () => !exited,
    stop() {
      child.stdin.end();
      child.kill();
    },
  };
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

let scratch = '';
let bare = '';
let clone = '';
let sshDir = '';
let bridge: Bridge;

beforeAll(() => {
  if (!fs.existsSync(bridgeEntry)) {
    throw new Error(
      `the companion has not been built: ${bridgeEntry} is missing — run \`npm run test:sys\` (which builds first)`,
    );
  }
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-bridge-sys-')));
  sshDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-bridge-sys-ssh-')));
  bare = path.join(scratch, 'remote.git');
  clone = path.join(scratch, 'clone');

  git(['init', '--bare', '--initial-branch=main', bare], scratch);
  git(['clone', bare, clone], scratch);
  git(['config', 'user.email', 'sys@example.test'], clone);
  git(['config', 'user.name', 'SYS Test'], clone);
  fs.mkdirSync(path.join(clone, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(clone, 'inbox', 'seed.md'), '# seed\n');
  git(['add', '--', 'inbox/seed.md'], clone);
  git(['commit', '-m', 'seed'], clone);
  git(['push', '-u', 'origin', 'main'], clone);

  bridge = startBridge(clone, sshDir);
});

afterAll(() => {
  bridge?.stop();
  for (const dir of [scratch, sshDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('companion SYS (F2)', () => {
  it('TC-F2-S01 handshakes over real stdio', async () => {
    const frame = await bridge.send('ping');
    expect(frame.ok).toBe(true);
    expect(frame.data).toMatchObject({ protocolVersion: 1 });
    expect(typeof (frame.data as { gitVersion: string }).gitVersion).toBe('string');
  });

  it('TC-F2-S02 reports the repository it was started on', async () => {
    const frame = await bridge.send('repo.info');
    expect(frame.ok).toBe(true);
    const info = frame.data as { root: string; branch: string; head: string | null };
    expect(fs.realpathSync(info.root)).toBe(fs.realpathSync(clone));
    expect(info.branch).toBe('main');
    expect(info.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('TC-F2-S03 status sees a clean tree, then a dirty one', async () => {
    const clean = await bridge.send('git.status');
    expect((clean.data as { dirty: string[] }).dirty).toEqual([]);

    fs.writeFileSync(path.join(clone, 'inbox', 'scratch.md'), 'uncommitted\n');
    const dirty = await bridge.send('git.status');
    expect((dirty.data as { dirty: string[] }).dirty).toContain('inbox/scratch.md');
    fs.rmSync(path.join(clone, 'inbox', 'scratch.md'));
  });

  it('TC-F2-S04 writes content and commits it through the real git', async () => {
    const frame = await bridge.send('git.write', {
      message: 'sync: add note from the bridge',
      files: [{ path: 'inbox/from-bridge.md', content: '# from bridge\n\nhello sys\n' }],
    });
    expect(frame.ok).toBe(true);
    const { sha, paths } = frame.data as { sha: string; paths: string[] };
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(paths).toEqual(['inbox/from-bridge.md']);

    expect(fs.readFileSync(path.join(clone, 'inbox', 'from-bridge.md'), 'utf8')).toContain('hello sys');
    expect(git(['log', '-1', '--pretty=%s'], clone).trim()).toBe('sync: add note from the bridge');
  });

  it('TC-F2-S05 pushes the commit to the bare remote', async () => {
    const frame = await bridge.send('git.push', { branch: 'main' });
    expect(frame.ok).toBe(true);
    expect((frame.data as { pushed: boolean }).pushed).toBe(true);

    // The bare remote is the authority: the file must exist in its tree, not just locally.
    const remoteTree = git(['ls-tree', '-r', '--name-only', 'main'], bare);
    expect(remoteTree).toContain('inbox/from-bridge.md');
  });

  it('TC-F2-S06 reads the pushed content back out of the remote-tracking ref', async () => {
    const show = await bridge.send('git.show', { rev: 'origin/main', path: 'inbox/from-bridge.md' });
    expect(show.ok).toBe(true);
    expect((show.data as { content: string }).content).toContain('hello sys');

    const ls = await bridge.send('git.ls', { rev: 'origin/main', dir: 'inbox' });
    const entries = (ls.data as { entries: Array<{ path: string }> }).entries.map((entry) => entry.path);
    expect(entries).toContain('inbox/from-bridge.md');
    expect(entries).toContain('inbox/seed.md');
  });

  it('TC-F2-S07 refuses to touch anything outside the configured root', async () => {
    const write = await bridge.send('git.write', {
      message: 'escape',
      files: [{ path: '../escaped.md', content: 'nope' }],
    });
    expect(write.ok).toBe(false);
    expect(write.code).toBe('pathOutsideRoot');
    expect(fs.existsSync(path.join(scratch, 'escaped.md'))).toBe(false);

    const show = await bridge.send('git.show', { rev: 'origin/main', path: '../../etc/passwd' });
    expect(show.ok).toBe(false);
    expect(show.code).toBe('pathOutsideRoot');

    // S4-01: the write primitive must not be usable to install a git hook or rewrite .git/config —
    // either would execute attacker-chosen code on the next `git commit`.
    for (const target of ['.git/hooks/pre-commit', '.GIT/hooks/post-commit', '.git/config']) {
      const attempt = await bridge.send('git.write', {
        message: 'escape via git metadata',
        files: [{ path: target, content: '#!/bin/sh\necho pwned\n' }],
      });
      expect(attempt.ok).toBe(false);
      expect(attempt.code).toBe('pathOutsideRoot');
    }
    expect(fs.existsSync(path.join(clone, '.git', 'hooks', 'pre-commit'))).toBe(false);
    expect(git(['config', 'user.email'], clone).trim()).toBe('sys@example.test');
  });

  it('TC-F2-S08 survives an unknown op and a malformed frame without dying', async () => {
    const unknown = await bridge.send('shell.exec', { cmd: 'rm -rf /' });
    expect(unknown.ok).toBe(false);
    expect(unknown.code).toBe('unknownOp');

    // A length prefix that is not followed by JSON: the loop must answer with an empty-id error frame
    // and keep serving, rather than desynchronising or exiting.
    const payload = Buffer.from('this is not json', 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    const malformed = bridge.next();
    bridge.raw(Buffer.concat([header, payload]));
    const errorFrame = await malformed;
    expect(errorFrame.ok).toBe(false);
    expect(errorFrame.code).toBe('badRequest');

    const after = await bridge.send('ping');
    expect(after.ok).toBe(true);
    expect(bridge.alive()).toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHandler } from '../src/main.js';
import { ERROR_MESSAGES, PROTOCOL_VERSION } from '../src/protocol.js';

/**
 * TC-F2-U11…U16 — the content channel (`git.show` / `git.ls` / `git.write`).
 *
 * These run against a real `git` in a real temporary repository: the point of the ops is that they
 * move bytes through the user's own git, and a mocked `execFile` would prove nothing about that.
 * Absence (`notFound`), confinement (`pathOutsideRoot`) and the size caps are asserted as hard
 * behaviour, not as "hopefully git fails".
 */

let root = '';
let handler: ReturnType<typeof createHandler>;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-bridge-content-')));
  git(['init', '--initial-branch=main']);
  git(['config', 'user.email', 'bridge@example.test']);
  git(['config', 'user.name', 'Bridge Test']);
  fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(root, 'inbox', 'note-one.md'), '# one\n\nbody one\n');
  git(['add', '--', 'inbox/note-one.md']);
  git(['commit', '-m', 'seed']);
  handler = createHandler({ repoRoot: root });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function call(op: string, args?: Record<string, unknown>, cwdOverride?: string) {
  return handler({ v: PROTOCOL_VERSION, id: `${op}-${Math.random()}`, op, cwd: cwdOverride ?? root, ...(args ? { args } : {}) } as never);
}

describe('content channel', () => {
  it('TC-F2-U11 git.show returns the file at a revision', async () => {
    const response = await call('git.show', { rev: 'HEAD', path: 'inbox/note-one.md' });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected ok');
    expect(response.data).toMatchObject({ rev: 'HEAD', path: 'inbox/note-one.md' });
    expect((response.data as { content: string }).content).toContain('body one');
    expect((response.data as { bytes: number }).bytes).toBeGreaterThan(0);
  });

  it('TC-F2-U12 a missing path is notFound, not an empty string', async () => {
    const response = await call('git.show', { rev: 'HEAD', path: 'inbox/nope.md' });
    expect(response).toEqual({
      v: PROTOCOL_VERSION,
      id: expect.any(String),
      ok: false,
      code: 'notFound',
      message: ERROR_MESSAGES.notFound,
    });
  });

  it('TC-F2-U13 git.ls lists a tree at a revision', async () => {
    const response = await call('git.ls', { rev: 'HEAD', dir: 'inbox' });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected ok');
    const data = response.data as { entries: Array<{ path: string; type: string; sha: string }> };
    expect(data.entries.map((entry) => entry.path)).toContain('inbox/note-one.md');
    expect(data.entries[0]?.type).toBe('blob');
    expect(data.entries[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('TC-F2-U14 git.write materialises content, commits it, and it reads back', async () => {
    const response = await call('git.write', {
      message: 'sync: add note-two',
      files: [{ path: 'inbox/note-two.md', content: '# two\n\nbody two\n' }],
    });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error('expected ok');
    expect((response.data as { paths: string[] }).paths).toEqual(['inbox/note-two.md']);
    expect((response.data as { sha: string }).sha).toMatch(/^[0-9a-f]{40}$/);

    // On disk, and committed (not merely staged).
    expect(fs.readFileSync(path.join(root, 'inbox', 'note-two.md'), 'utf8')).toContain('body two');
    expect(git(['status', '--porcelain']).trim()).toBe('');
    const back = await call('git.show', { rev: 'HEAD', path: 'inbox/note-two.md' });
    expect(back.ok).toBe(true);
  });

  it('TC-F2-U15 a write target outside the root is refused and nothing is created', async () => {
    const escapee = path.join(root, '..', `escaped-${Date.now()}.md`);
    const response = await call('git.write', {
      message: 'sync: escape',
      files: [{ path: '../escaped.md', content: 'nope' }],
    });
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error('expected refusal');
    expect(response.code).toBe('pathOutsideRoot');
    expect(fs.existsSync(escapee)).toBe(false);
  });

  it('TC-F2-U17 refuses to write into the git directory (S4-01)', async () => {
    // A hook written here would be executed by the very next `git commit`; `.git/config` can set
    // core.hooksPath/core.sshCommand. Neither is content, so neither may be a write target.
    for (const target of ['.git/hooks/pre-commit', '.GIT/hooks/post-commit', '.git/config']) {
      const response = await call('git.write', {
        message: 'sync: nope',
        files: [{ path: target, content: '#!/bin/sh\necho pwned\n' }],
      });
      expect(response.ok).toBe(false);
      if (response.ok) throw new Error('expected refusal');
      expect(response.code).toBe('pathOutsideRoot');
    }
    expect(fs.existsSync(path.join(root, '.git', 'hooks', 'pre-commit'))).toBe(false);
    // `.GIT` cannot be probed with existsSync: Windows is case-insensitive, so it would match the real
    // `.git` directory and read as a success. The hook path is the honest assertion.
    expect(fs.existsSync(path.join(root, '.git', 'hooks', 'post-commit'))).toBe(false);
    // The repository's own identity must be untouched.
    expect(git(['config', 'user.email']).trim()).toBe('bridge@example.test');
  });

  it('TC-F2-U16 argv-shaped input is rejected before git runs', async () => {
    const injectedRev = await call('git.show', { rev: '--upload-pack=touch /tmp/pwned', path: 'a.md' });
    expect(injectedRev.ok).toBe(false);
    if (injectedRev.ok) throw new Error('expected refusal');
    expect(injectedRev.code).toBe('badRequest');

    const tooBig = await call('git.write', {
      message: 'sync: big',
      files: [{ path: 'inbox/big.md', content: 'x'.repeat(600 * 1024) }],
    });
    expect(tooBig.ok).toBe(false);
    if (tooBig.ok) throw new Error('expected refusal');
    expect(tooBig.code).toBe('frameTooLarge');

    const noFiles = await call('git.write', { message: 'sync: empty', files: [] });
    expect(noFiles.ok).toBe(false);
    expect(fs.existsSync(path.join(root, 'inbox', 'big.md'))).toBe(false);
  });
});

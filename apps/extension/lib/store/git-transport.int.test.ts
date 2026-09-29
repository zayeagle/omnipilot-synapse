import { describe, expect, it } from 'vitest';
import { NativeClient, createFakePort } from '../native/client';
import { ConflictError, NotConfiguredError } from './errors';
import { GitTransportStore, createGitTransportStore } from './git-transport';

/**
 * TC-F1-I02 — the SSH transport, against a scripted companion.
 *
 * The point of these tests is the *contract* this file owns: reads come from the remote-tracking ref,
 * a missing path is `null`, and a rejected push surfaces as a conflict so the caller keeps the paths
 * dirty instead of believing the write landed.
 */

function ok(id: string, data: unknown) {
  return { v: 1, id, ok: true, data };
}

function fail(id: string, code: string, message: string) {
  return { v: 1, id, ok: false, code, message };
}

interface FakeRepo {
  files: Record<string, string>;
  pushFails: boolean;
  sent: Array<{ op: string; args?: Record<string, unknown> }>;
  /** Commits the clone is ahead of the remote by, reported by `git.fetch`. */
  ahead?: number;
}

function makeStore(repo: FakeRepo) {
  const port = createFakePort((message) => {
    const request = message as { id: string; op: string; args?: Record<string, unknown> };
    repo.sent.push({ op: request.op, ...(request.args ? { args: request.args } : {}) });
    switch (request.op) {
      case 'ping':
        return ok(request.id, { protocolVersion: 1, gitVersion: '2.54.0', platform: 'test', node: '22' });
      case 'git.probe':
        return ok(request.id, {
          root: '/clone',
          branch: 'main',
          head: 'a'.repeat(40),
          remoteUrl: 'git@github.com:o/r.git',
          dirty: false,
          reachable: true,
          remoteBranchExists: true,
        });
      case 'git.show': {
        const path = String(request.args?.['path'] ?? '');
        const content = repo.files[path];
        if (content === undefined) return fail(request.id, 'notFound', 'path does not exist at the requested revision');
        return ok(request.id, { rev: 'origin/main', path, content, bytes: content.length });
      }
      case 'git.ls': {
        const dir = request.args?.['dir'];
        const keys = Object.keys(repo.files).filter((path) => dir === null || dir === undefined || path.startsWith(`${String(dir)}/`));
        return ok(request.id, {
          rev: 'origin/main',
          dir: typeof dir === 'string' ? dir : '',
          entries: keys.map((path) => ({ path, type: 'blob', sha: 'b'.repeat(40), size: repo.files[path]?.length ?? 0 })),
        });
      }
      case 'git.write': {
        const files = (request.args?.['files'] ?? []) as Array<{ path: string; content: string }>;
        for (const file of files) repo.files[file.path] = file.content;
        return ok(request.id, { sha: 'c'.repeat(40), paths: files.map((file) => file.path) });
      }
      case 'git.fetch':
        return ok(request.id, { head: 'e'.repeat(40), ahead: repo.ahead, behind: 0 });
      case 'git.push':
        if (repo.pushFails) return fail(request.id, 'nonFastForward', 'push was rejected as non-fast-forward');
        return ok(request.id, { head: 'd'.repeat(40), pushed: true });
      default:
        return fail(request.id, 'unknownOp', 'operation is not allowed');
    }
  });
  const native = new NativeClient({ connect: () => port, hostName: 'test.host' });
  return { store: new GitTransportStore({ native, repoRoot: '/clone', branch: 'main', repoFullName: 'o/r' }), port };
}

describe('GitTransportStore (F1 INT)', () => {
  it('TC-F1-I02 reads target the remote-tracking ref and a missing path is null', async () => {
    const repo: FakeRepo = { files: { 'inbox/a.md': '# a\n' }, pushFails: false, sent: [] };
    const { store } = makeStore(repo);

    expect(store.rev).toBe('origin/main');
    await expect(store.readFile('inbox/a.md')).resolves.toBe('# a\n');
    await expect(store.readFile('inbox/missing.md')).resolves.toBeNull();

    const show = repo.sent.filter((entry) => entry.op === 'git.show');
    expect(show.length).toBe(2);
    for (const call of show) expect(call.args?.['rev']).toBe('origin/main');
  });

  it('TC-F1-I02 probe maps the companion report into a store probe', async () => {
    const repo: FakeRepo = { files: {}, pushFails: false, sent: [] };
    const { store } = makeStore(repo);
    const probe = await store.probe();
    expect(probe).toMatchObject({
      kind: 'github',
      repoFullName: 'o/r',
      // SSH access is not evidence of privacy — the companion cannot know.
      visibility: 'unknown',
      defaultBranch: 'main',
      canWrite: true,
    });
  });

  it('TC-F1-I02 listDir maps blobs onto directory entries', async () => {
    const repo: FakeRepo = { files: { 'inbox/a.md': 'a', 'inbox/b.md': 'bb', 'cards/c.md': 'c' }, pushFails: false, sent: [] };
    const { store } = makeStore(repo);
    const entries = await store.listDir('inbox');
    expect(entries.map((entry) => entry.path).sort()).toEqual(['inbox/a.md', 'inbox/b.md']);
    expect(entries[0]).toMatchObject({ type: 'file', name: 'a.md' });
  });

  it('TC-F1-I02 commitFiles writes, pushes and reports the pushed head', async () => {
    const repo: FakeRepo = { files: {}, pushFails: false, sent: [] };
    const { store } = makeStore(repo);
    const result = await store.commitFiles([{ path: 'inbox/new.md', content: 'hello' }], 'sync: add');
    expect(result.sha).toBe('d'.repeat(40));
    expect(result.paths).toEqual(['inbox/new.md']);
    expect(result.htmlUrl).toContain('/commit/');
    expect(repo.files['inbox/new.md']).toBe('hello');
    expect(repo.sent.map((entry) => entry.op)).toEqual(['git.write', 'git.push']);
  });

  it('TC-F1-I02 a rejected push is a conflict, never a silent success', async () => {
    const repo: FakeRepo = { files: {}, pushFails: true, sent: [] };
    const { store } = makeStore(repo);
    await expect(store.commitFiles([{ path: 'a.md', content: 'x' }], 'sync')).rejects.toBeInstanceOf(ConflictError);
    // The caller must be able to tell "queued" from "done": the promise rejected, nothing was cleared.
    expect(repo.sent.filter((entry) => entry.op === 'git.push')).toHaveLength(1);
  });

  it('TC-F1-I02 an unavailable companion becomes a configuration error, not a crash', async () => {
    const native = new NativeClient({
      connect: () => {
        throw new Error('no such host');
      },
    });
    const store = createGitTransportStore({ native, repoRoot: '/clone', branch: 'main' });
    await expect(store.probe()).rejects.toBeInstanceOf(NotConfiguredError);
  });

  it('TC-F1-I02 refresh() surfaces the ahead/behind report the engine needs', async () => {
    const repo: FakeRepo = { files: {}, pushFails: false, sent: [], ahead: 2 };
    const { store } = makeStore(repo);
    await expect(store.refresh()).resolves.toEqual({ head: 'e'.repeat(40), ahead: 2, behind: 0 });
    expect(repo.sent.map((entry) => entry.op)).toContain('git.fetch');
  });
});

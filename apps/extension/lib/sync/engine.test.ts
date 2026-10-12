import { describe, expect, it } from 'vitest';
import { indexPath } from '../core/paths';
import { VaultLockedError } from '../security/key-session';
import { SearchIndex } from '../search/index';
import { createMemoryBackend, SyncCache } from './cache';
import { runSync, type SyncDeps, type SyncRemote } from './engine';
import { createLocalShardStore, createMemoryShardBackend } from '../search/local-store';
import { serializeIndex, type IndexFile } from '../store/tier';
import type { ContentCodec, IndexItem } from '../store/codec';
import type { CkfRecord, SourceItem } from '../core/ckf';
import type { DirEntry, RepoFile } from '../store/types';

/**
 * TC-F3-U08…U12 — the sync engine, driven by a scripted repository.
 *
 * Every assertion here is about a *decision* the engine makes (what to fetch, what to write, what may
 * leave the dirty set), not about mechanics: the transport is a `Map` and the codec is JSON, so a
 * failure means the reconciliation logic is wrong rather than the mock being awkward.
 */

const V1 = '2026-01-01T10:00:00.000Z';
const V2 = '2026-01-02T10:00:00.000Z';

function source(id: string, version: string): SourceItem {
  return {
    id,
    kind: 'source',
    channel: 'extension',
    url: `https://example.test/${id}`,
    title: `note ${id}`,
    body: `body of ${id}`,
    content_hash: `hash-${id}`,
    captured_at: version,
    tags: [],
  };
}

const pathOf = (record: CkfRecord): string => `inbox/${record.id}.md`;

const codec: ContentCodec = {
  mode: 'transparent',
  extension: '.md',
  async encode(record) {
    return `REC:${JSON.stringify(record)}`;
  },
  async decode(text) {
    return JSON.parse(text.replace(/^REC:/u, '')) as CkfRecord;
  },
  matches: (path) => path.endsWith('.md'),
  indexEntry(record, path): IndexItem {
    const version = record.kind === 'source' ? record.captured_at : V1;
    return {
      id: record.id,
      kind: record.kind,
      path,
      created_at: version,
      updated_at: version,
      content_key: `ck:${version}`,
    };
  },
  async encodeRecord(record, prefix) {
    const path = pathOf(record);
    return {
      path: prefix ? `${prefix}/${path}` : path,
      content: await this.encode(record),
      index: this.indexEntry(record, path),
    };
  },
};

function manifestOf(records: readonly CkfRecord[]): IndexFile {
  const items: Record<string, IndexItem> = {};
  for (const record of records) {
    const item = codec.indexEntry(record, pathOf(record));
    items[item.id] = item;
  }
  return { schema: 1, items } as IndexFile;
}

interface FakeRemote {
  remote: SyncRemote;
  files: Map<string, string>;
  reads: string[];
  commits: Array<{ files: RepoFile[]; message: string }>;
  failCommits: boolean;
}

function fakeRemote(manifest: IndexFile, bodies: Record<string, string> = {}): FakeRemote {
  const files = new Map<string, string>([[indexPath(), serializeIndex(manifest)], ...Object.entries(bodies)]);
  const reads: string[] = [];
  const commits: Array<{ files: RepoFile[]; message: string }> = [];
  const state: FakeRemote = {
    files,
    reads,
    commits,
    failCommits: false,
    remote: {
      async readIndex() {
        const text = files.get(indexPath()) ?? null;
        const { parseIndex } = await import('../store/tier');
        return parseIndex(text);
      },
      async readFile(path) {
        reads.push(path);
        return files.get(path) ?? null;
      },
      async listDir(path) {
        const prefix = `${path}/`;
        const entries: DirEntry[] = [];
        for (const key of files.keys()) {
          if (!key.startsWith(prefix)) continue;
          entries.push({ name: key.slice(prefix.length), path: key, sha: '', type: 'file' });
        }
        return entries;
      },
      async commitFiles(list, message) {
        if (state.failCommits) throw new Error('push rejected');
        commits.push({ files: list, message });
        for (const file of list) files.set(file.path, file.content);
        return { sha: `sha-${commits.length}`, htmlUrl: '', paths: list.map((file) => file.path) };
      },
      async refresh() {
        /* the fake repository is always current */
      },
    },
  };
  return state;
}

function depsFor(fake: FakeRemote, overrides: Partial<SyncDeps> = {}): SyncDeps {
  const cache = overrides.cache ?? new SyncCache(createMemoryBackend());
  // The index lives on this machine, so the engine writes into a local store and commits no shards.
  const index = new SearchIndex({ store: createLocalShardStore(createMemoryShardBackend()), pathOf });
  return {
    cache,
    index,
    codec,
    remote: fake.remote,
    prefix: null,
    ...overrides,
  };
}

describe('sync engine (F3 UNIT)', () => {
  it('TC-F3-U08 pulls only the records whose version moved', async () => {
    const a = source('a', V1);
    const b = source('b', V2);
    const fake = fakeRemote(manifestOf([a, b]), {
      [pathOf(a)]: await codec.encode(a),
      [pathOf(b)]: await codec.encode(b),
    });
    const cache = new SyncCache(createMemoryBackend());
    // `a` is already at the remote's version; `b` is new to us.
    await cache.put(a, { path: pathOf(a), sha: '', contentKey: 'ck:' + V1, remoteUpdatedAt: V1 });

    const report = await runSync(depsFor(fake, { cache }), 'manual');

    expect(report.outcome).toBe('pulled');
    expect(report.pulled).toBe(1);
    expect(fake.reads).toEqual([pathOf(b)]);
    expect((await cache.get(pathOf(a)))?.id).toBe('a');
    expect((await cache.get(pathOf(b)))?.id).toBe('b');
  });

  it('TC-F3-U12 a second run is a no-op — nothing is re-fetched and nothing is committed', async () => {
    const b = source('b', V2);
    const fake = fakeRemote(manifestOf([b]), { [pathOf(b)]: await codec.encode(b) });
    const deps = depsFor(fake);

    await runSync(deps, 'manual');
    const readsAfterFirst = [...fake.reads];
    const second = await runSync(deps, 'manual');

    expect(second.outcome).toBe('upToDate');
    expect(second.pulled).toBe(0);
    expect(fake.reads).toEqual(readsAfterFirst);
    expect(fake.commits).toHaveLength(0);
  });

  it('TC-F3-U10 a locked vault aborts before anything is cached (SC-F5-04)', async () => {
    const b = source('b', V2);
    const fake = fakeRemote(manifestOf([b]), { [pathOf(b)]: await codec.encode(b) });
    const cache = new SyncCache(createMemoryBackend());
    const deps = depsFor(fake, {
      cache,
      codec: { ...codec, mode: 'vault' },
      session: { isUnlocked: () => false },
    });

    await expect(runSync(deps, 'manual')).rejects.toBeInstanceOf(VaultLockedError);
    expect(fake.reads).toEqual([]);
    expect(await cache.all()).toEqual([]);
  });

  it('TC-F3-U11 a remote deletion is dropped locally and committed as an index change', async () => {
    const gone = source('gone', V1);
    const fake = fakeRemote(manifestOf([]));
    const cache = new SyncCache(createMemoryBackend());
    await cache.put(gone, { path: pathOf(gone), sha: 'sha-old', contentKey: 'ck:' + V1, remoteUpdatedAt: V1 });

    const report = await runSync(depsFor(fake, { cache }), 'manual');

    expect(report.removed).toBe(1);
    expect(await cache.get(pathOf(gone))).toBeNull();
    expect(fake.commits).toHaveLength(1);
    const committed = fake.commits[0]?.files.map((file) => file.path) ?? [];
    expect(committed).toContain(indexPath());
    expect(committed).not.toContain(pathOf(gone));
  });

  it('TC-F3-U09 push writes the record and the manifest in one commit, indexes it here, then clears dirty', async () => {
    const fresh = source('fresh', V2);
    const fake = fakeRemote(manifestOf([]));
    const cache = new SyncCache(createMemoryBackend());
    await cache.put(fresh, { path: pathOf(fresh), sha: '', markDirty: true });

    const deps = depsFor(fake, { cache });
    const report = await runSync(deps, 'capture');

    expect(report.outcome).toBe('pushed');
    expect(report.pushed).toBe(1);
    expect(fake.commits).toHaveLength(1);
    const paths = fake.commits[0]?.files.map((file) => file.path) ?? [];
    expect(paths).toContain(pathOf(fresh));
    expect(paths).toContain(indexPath());
    // The index is this machine's: the pushed record is indexed HERE and never committed (F17).
    expect(paths.some((path) => path.startsWith('search/'))).toBe(false);
    expect((await deps.index.listShardKeys()).length).toBeGreaterThan(0);
    expect(fake.commits[0]?.message).toContain('sync(capture)');
    expect(await cache.dirty()).toEqual([]);
  });

  it('TC-F3-U06 both versions survive a conflict; the remote keeps the path', async () => {
    const remoteVersion = source('c', V1);
    const localVersion: SourceItem = { ...remoteVersion, title: 'locally edited', captured_at: V2 };
    const fake = fakeRemote(manifestOf([remoteVersion]), {
      [pathOf(remoteVersion)]: await codec.encode(remoteVersion),
    });
    const cache = new SyncCache(createMemoryBackend());
    // The cache remembers an *older* remote version than the manifest now carries, and the path is
    // dirty: both sides moved, which is exactly the conflict case.
    await cache.put(localVersion, {
      path: pathOf(localVersion),
      sha: 'sha-local',
      markDirty: true,
      contentKey: 'ck:stale',
      remoteUpdatedAt: '2025-12-31T10:00:00.000Z',
    });

    const report = await runSync(depsFor(fake, { cache }), 'manual');

    expect(report.conflicts).toEqual([pathOf(localVersion)]);
    expect(report.outcome).toBe('conflict');
    const paths = fake.commits[0]?.files.map((file) => file.path) ?? [];
    expect(paths.some((path) => path.includes('.conflict-'))).toBe(true);
  });

  it('TC-F3-I05 a rejected push keeps the path queued instead of pretending it landed', async () => {
    const fresh = source('fresh', V2);
    const fake = fakeRemote(manifestOf([]));
    fake.failCommits = true;
    const cache = new SyncCache(createMemoryBackend());
    await cache.put(fresh, { path: pathOf(fresh), sha: '', markDirty: true });

    await expect(runSync(depsFor(fake, { cache }), 'manual')).rejects.toThrow();
    expect(await cache.dirty()).toEqual([pathOf(fresh)]);
    expect((await cache.state()).lastOutcome).toBe('never');
  });

  it('TC-F3-U04 pull-only never writes, and reports what is still pending', async () => {
    const b = source('b', V2);
    const local = source('local', V2);
    const fake = fakeRemote(manifestOf([b]), { [pathOf(b)]: await codec.encode(b) });
    const cache = new SyncCache(createMemoryBackend());
    await cache.put(local, { path: pathOf(local), sha: '', markDirty: true });

    const report = await runSync(
      depsFor(fake, { cache, policy: { intervalMinutes: 30, onStartup: true, onCapture: true, pullOnly: true } }),
      'alarm',
    );

    expect(report.pulled).toBe(1);
    expect(report.pushed).toBe(0);
    expect(report.pending).toBe(1);
    expect(fake.commits).toHaveLength(0);
    expect(await cache.dirty()).toEqual([pathOf(local)]);
  });

  it('TC-F3-I06 the ssh transport refreshes before it reads', async () => {
    const b = source('b', V2);
    const fake = fakeRemote(manifestOf([b]), { [pathOf(b)]: await codec.encode(b) });
    let refreshed = 0;
    const deps = depsFor(fake);
    const remote: SyncRemote = { ...fake.remote, refresh: async () => { refreshed += 1; } };

    await runSync({ ...deps, remote }, 'manual');
    expect(refreshed).toBe(1);
  });
});

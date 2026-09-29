import { describe, expect, it, vi } from 'vitest';

import { indexPath } from '../core/paths';
import type { CaptureRequestPayload } from '../messages';
import { CaptureQueue } from '../queues';
import { MemoryStorageArea } from '../settings-store';
import { transparentCodec } from '../store/codec';
import { NetworkError } from '../store/errors';
import { GitHubStore } from '../store/github-store';
import type { GithubApi } from '../store/github-api';
import { parseIndex } from '../store/tier';
import type { CommitResult, RepoFile, StoreProbe } from '../store/types';
import { SearchIndex } from '../search/index';
import { createRemoteShardStore } from '../sync/shard-store';
import { CaptureService, MIN_CONTENT_DEDUP_CHARS, dedupContentKey, isTransientStoreError } from './service';

const PROBE: StoreProbe = {
  kind: 'github',
  repoFullName: 'zayeagle/omnipilot-synapse',
  visibility: 'private',
  defaultBranch: 'main',
  canPush: true,
  canWrite: true,
  checkedAt: '2026-07-09T00:00:00.000Z',
};

const FIXED_NOW = Date.parse('2026-07-09T00:00:00.000Z');

/** An in-memory stand-in for the repository, so reads and writes are exercised for real. */
function memoryApi(options: { failCommitsWith?: Error } = {}) {
  const files = new Map<string, string>();
  const state = { commits: 0, commitFiles: [] as RepoFile[][] };

  const api: GithubApi = {
    probeRepo: async () => ({ ...PROBE }),
    readFile: async (path: string) => files.get(path) ?? null,
    // Real listings, so the search layer can discover the committed shards (F4).
    listDir: async (path: string) => {
      const prefix = path.length > 0 ? `${path}/` : '';
      return [...files.keys()]
        .filter((key) => key.startsWith(prefix) && key !== path)
        .map((key) => ({ name: key.slice(prefix.length), path: key, sha: '', type: 'file' as const }));
    },
    commitFiles: async (incoming: RepoFile[], _message: string): Promise<CommitResult> => {
      if (options.failCommitsWith) throw options.failCommitsWith;
      state.commits += 1;
      state.commitFiles.push(incoming);
      for (const file of incoming) files.set(file.path, file.content);
      return {
        sha: `commit${state.commits}`,
        htmlUrl: `https://github.com/zayeagle/omnipilot-synapse/commit/commit${state.commits}`,
        paths: incoming.map((file) => file.path),
      };
    },
  };

  return { api, files, state };
}

function makeService(api: GithubApi, queue = new CaptureQueue(new MemoryStorageArea(), () => FIXED_NOW)) {
  const store = new GitHubStore({
    api,
    codec: transparentCodec,
    repoFullName: 'zayeagle/omnipilot-synapse',
    branch: 'main',
    now: () => FIXED_NOW,
  });
  return { service: new CaptureService({ store, queue, now: () => FIXED_NOW }), store, queue };
}

const LONG_BODY = 'A'.repeat(MIN_CONTENT_DEDUP_CHARS + 50);

/**
 * TC-F4-I02 — the note and the shards that index it are **one commit**.
 *
 * The capture path commits directly (it does not go through the sync engine), so if it forgot the
 * shards a captured note would be invisible to `search.query` — which reads the committed shards.
 * That is exactly the failure this test exists to prevent.
 */
async function captureWithShards() {
  const { api, files, state } = memoryApi();
  const store = new GitHubStore({
    api,
    codec: transparentCodec,
    repoFullName: 'zayeagle/omnipilot-synapse',
    branch: 'main',
    now: () => FIXED_NOW,
  });
  const shards = createRemoteShardStore(store, null);
  const index = new SearchIndex({ store: shards, prefix: null, now: () => FIXED_NOW });
  const queue = new CaptureQueue(new MemoryStorageArea(), () => FIXED_NOW);
  const service = new CaptureService({
    store,
    queue,
    now: () => FIXED_NOW,
    shards: (record) => index.changedShards(record),
  });
  return { service, index, state, files };
}

const PAGE_PAYLOAD: CaptureRequestPayload = {
  mode: 'page',
  url: 'https://example.com/article?utm_source=newsletter',
  title: 'An article',
  body: LONG_BODY,
};

describe('capture pipeline (F1 INT)', () => {
  it('TC-F1-I01 writes the record and the index in one commit', async () => {
    const { api, state } = memoryApi();
    const { service } = makeService(api);

    const outcome = await service.capture(PAGE_PAYLOAD);

    expect(state.commits).toBe(1);
    expect(outcome.duplicate).toBe(false);
    expect(outcome.queued).toBe(false);
    expect(outcome.path).toMatch(/^inbox\/2026\/07\/an-article-[0-9a-z]{8}\.md$/u);
    expect(outcome.commitUrl).toBe('https://github.com/zayeagle/omnipilot-synapse/commit/commit1');

    const committed = state.commitFiles[0]?.map((file) => file.path) ?? [];
    expect(committed).toEqual([outcome.path, indexPath()]);

    const index = parseIndex(await api.readFile(indexPath()));
    expect(Object.keys(index.items)).toEqual([outcome.item.id]);
    expect(index.items[outcome.item.id]).toMatchObject({
      kind: 'source',
      path: outcome.path,
      // The URL is stored canonically: the working index is safe to read in transparent mode.
      url_key: 'https://example.com/article',
      content_key: outcome.item.content_hash,
    });
  });

  it('TC-F1-I02 reports the existing item instead of writing it twice', async () => {
    const { api, state } = memoryApi();
    const { service } = makeService(api);

    const first = await service.capture(PAGE_PAYLOAD);
    // Same page reached through a different tracking link and with different cosmetic whitespace.
    const second = await service.capture({
      ...PAGE_PAYLOAD,
      url: 'https://www.example.com/article/',
      body: LONG_BODY.replace('A', 'A '),
    });

    expect(state.commits).toBe(1);
    expect(second.duplicate).toBe(true);
    expect(second.path).toBe(first.path);
    expect(second.commitUrl).toBe(
      `https://github.com/zayeagle/omnipilot-synapse/blob/main/${first.path}`,
    );
  });

  it('TC-F1-I02 does not treat two empty-bodied pages as duplicates', async () => {
    const { api, state } = memoryApi();
    const { service } = makeService(api);

    const a = await service.capture({ mode: 'page', url: 'https://example.com/a', title: 'A', body: '' });
    const b = await service.capture({ mode: 'page', url: 'https://example.com/b', title: 'B', body: '' });

    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false);
    expect(state.commits).toBe(2);
    expect(dedupContentKey(a.item)).toBe('');
    expect(dedupContentKey(b.item)).toBe('');
  });

  it('TC-F1-I02 still catches a near-duplicate long body from another URL', async () => {
    const { api, state } = memoryApi();
    const { service } = makeService(api);
    const third = `${LONG_BODY.slice(0, -1)}B`;

    await service.capture({ mode: 'page', url: 'https://example.com/original', title: 'T', body: LONG_BODY });
    const duplicate = await service.capture({
      mode: 'page',
      url: 'https://mirror.example.com/copy',
      title: 'T',
      body: third,
    });

    expect(duplicate.duplicate).toBe(false); // different content hash → not an exact duplicate
    expect(state.commits).toBe(2);
  });

  it('TC-F1-I01 records a selection capture with its excerpt source', async () => {
    const { api, files } = memoryApi();
    const { service } = makeService(api);

    const outcome = await service.capture({
      mode: 'selection',
      url: 'https://example.com/long',
      title: 'Long page',
      selection: 'the quoted passage',
      byline: 'surrounding paragraph',
    });

    const written = files.get(outcome.path) ?? '';
    expect(written).toContain('excerpt_of: "https://example.com/long"');
    expect(written).toContain('the quoted passage');
    expect(outcome.item.excerpt_of).toBe('https://example.com/long');
  });

  it('TC-F1-I01 queues a transient failure and replays it later', async () => {
    const failing = memoryApi({ failCommitsWith: new NetworkError() });
    const queue = new CaptureQueue(new MemoryStorageArea(), () => FIXED_NOW);
    const { service } = makeService(failing.api, queue);

    const outcome = await service.capture(PAGE_PAYLOAD);
    expect(outcome.queued).toBe(true);
    expect(await queue.size()).toBe(1);
    expect(failing.state.commits).toBe(0);

    // Swap the failing api for a working one and flush.
    const working = memoryApi();
    const replay = makeService(working.api, queue);
    const flushed = await replay.service.flushQueue();

    expect(flushed).toEqual({ flushed: 1, remaining: 0 });
    expect(working.state.commits).toBe(1);
    expect(isTransientStoreError(new NetworkError())).toBe(true);
    expect(isTransientStoreError(new Error('boom'))).toBe(false);
  });

  it('TC-F1-I01 stops the flush at the first transient failure so a downed host is not hammered', async () => {
    const queue = new CaptureQueue(new MemoryStorageArea(), () => FIXED_NOW);
    await queue.enqueue(PAGE_PAYLOAD);
    await queue.enqueue({ ...PAGE_PAYLOAD, url: 'https://example.com/second', body: `${LONG_BODY}X` });

    const failing = memoryApi({ failCommitsWith: new NetworkError() });
    const { service } = makeService(failing.api, queue);
    const result = await service.flushQueue();

    expect(result.flushed).toBe(0);
    expect(await queue.size()).toBe(2);
  });

  it('TC-F1-I01 surfaces a permanent failure instead of queueing it', async () => {
    const { api } = memoryApi();
    const queue = new CaptureQueue(new MemoryStorageArea(), () => FIXED_NOW);
    const { service } = makeService(api, queue);
    const permanent = new Error('validation: bad payload');
    vi.spyOn(api, 'commitFiles').mockRejectedValue(permanent);

    await expect(service.capture(PAGE_PAYLOAD)).rejects.toThrow(/bad payload/u);
    expect(await queue.size()).toBe(0);
  });

  it('TC-F4-I02 commits the note, its index entry and its postings shards in one commit', async () => {
    const { service, index, state } = await captureWithShards();

    const outcome = await service.capture(PAGE_PAYLOAD);

    expect(outcome.duplicate).toBe(false);
    expect(state.commits).toBe(1);
    const committed = (state.commitFiles[0] ?? []).map((file) => file.path);
    expect(committed).toContain(outcome.path);
    expect(committed).toContain(indexPath());
    expect(committed.some((path) => path.startsWith('search/'))).toBe(true);

    // The note must be findable from exactly the shards that were committed with it.
    const hits = await index.query('article');
    expect(hits.map((hit) => hit.path)).toContain(outcome.path);
  });

  it('TC-F4-I02 a failing shard computation never loses the capture', async () => {
    const { api, state } = memoryApi();
    const store = new GitHubStore({
      api,
      codec: transparentCodec,
      repoFullName: 'zayeagle/omnipilot-synapse',
      branch: 'main',
      now: () => FIXED_NOW,
    });
    const service = new CaptureService({
      store,
      queue: new CaptureQueue(new MemoryStorageArea(), () => FIXED_NOW),
      now: () => FIXED_NOW,
      shards: () => Promise.reject(new Error('index unavailable')),
    });

    const outcome = await service.capture(PAGE_PAYLOAD);

    // The note is stored (it is not rebuildable); only the derived index is missing.
    expect(outcome.queued).toBe(false);
    expect(state.commits).toBe(1);
    expect((state.commitFiles[0] ?? []).some((file) => file.path.startsWith('search/'))).toBe(false);
  });
});

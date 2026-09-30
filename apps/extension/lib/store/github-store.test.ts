import { describe, expect, it, vi } from 'vitest';

import { newSourceItem, newKnowledgeCard } from '../core/ckf';
import { indexPath } from '../core/paths';
import { PublicRepoError, ScopeError } from './errors';
import { transparentCodec } from './codec';
import { GitHubStore, MAX_COMMIT_FILES, defaultCommitMessage } from './github-store';
import type { GithubApi } from './github-api';
import type { CommitResult, RepoFile, StoreProbe } from './types';
import { emptyIndex, mergeIndex, indexToFile } from './tier';

const PRIVATE_PROBE: StoreProbe = {
  kind: 'github',
  repoFullName: 'zayeagle/omnipilot-synapse',
  visibility: 'private',
  defaultBranch: 'main',
  canPush: true,
  canWrite: true,
  checkedAt: '2026-07-09T00:00:00.000Z',
};

interface FakeApi extends GithubApi {
  commits: Array<{ files: RepoFile[]; message: string }>;
}

function fakeApi(overrides: Partial<GithubApi> = {}): FakeApi {
  const commits: Array<{ files: RepoFile[]; message: string }> = [];
  return {
    probeRepo: async () => ({ ...PRIVATE_PROBE }),
    readFile: async () => null,
    listDir: async () => [],
    commitFiles: async (files: RepoFile[], message: string): Promise<CommitResult> => {
      commits.push({ files, message });
      return {
        sha: `sha${commits.length}`,
        htmlUrl: `https://github.com/zayeagle/omnipilot-synapse/commit/sha${commits.length}`,
        paths: files.map((file) => file.path),
      };
    },
    ...overrides,
    commits,
  };
}

function makeStore(api: GithubApi, acknowledged = false): GitHubStore {
  return new GitHubStore({
    api,
    codec: transparentCodec,
    repoFullName: 'zayeagle/omnipilot-synapse',
    publicRepoAcknowledged: acknowledged,
    now: () => Date.parse('2026-07-09T00:00:00.000Z'),
  });
}

const SOURCE = newSourceItem({
  url: 'https://example.com/a',
  title: 'A capture',
  body: 'Body text',
  capturedAt: new Date('2026-07-09T00:00:00.000Z'),
});

describe('public repository guard (F6 UNIT)', () => {
  it('TC-F6-U05 blocks a public repository until it is acknowledged', async () => {
    const api = fakeApi({
      probeRepo: async () => ({ ...PRIVATE_PROBE, visibility: 'public', canWrite: false, warning: 'public-repo' }),
    });
    const store = makeStore(api);

    const probe = await store.probe();
    expect(probe.visibility).toBe('public');
    expect(probe.canWrite).toBe(false);
    expect(probe.warning).toBe('public-repo');

    await expect(store.assertWritable()).rejects.toThrow(PublicRepoError);
    await expect(store.commitRecord(SOURCE)).rejects.toThrow(PublicRepoError);
    expect(api.commits).toHaveLength(0);
  });

  it('TC-F6-U05 allows a public repository once the risk is acknowledged', async () => {
    const api = fakeApi({
      probeRepo: async () => ({ ...PRIVATE_PROBE, visibility: 'public', canWrite: false, warning: 'public-repo' }),
      readFile: async () => null,
    });
    const store = makeStore(api, true);
    await expect(store.assertWritable()).resolves.toMatchObject({ visibility: 'public' });
  });

  it('TC-F6-U05 refuses to write without push permission', async () => {
    const api = fakeApi({ probeRepo: async () => ({ ...PRIVATE_PROBE, canPush: false, canWrite: false }) });
    await expect(makeStore(api).assertWritable()).rejects.toThrow(ScopeError);
  });

  it('TC-F6-U05 probes before it encodes, so a blocked write costs nothing', async () => {
    const api = fakeApi({
      probeRepo: async () => ({ ...PRIVATE_PROBE, visibility: 'public', canWrite: false }),
    });
    const decode = vi.spyOn(transparentCodec, 'encodeRecord');
    await expect(makeStore(api).commitRecord(SOURCE)).rejects.toThrow(PublicRepoError);
    expect(decode).not.toHaveBeenCalled();
    decode.mockRestore();
  });
});

describe('atomic record commit (F6 UNIT)', () => {
  it('TC-F6-U01 writes the record and the index in a single commit', async () => {
    const api = fakeApi();
    const store = makeStore(api);

    const result = await store.commitRecord(SOURCE, { message: 'capture: test' });

    expect(api.commits).toHaveLength(1);
    const commit = api.commits[0];
    expect(commit?.message).toBe('capture: test');
    expect(commit?.files.map((file) => file.path)).toEqual([result.path, indexPath()]);
    expect(result.path).toMatch(/^inbox\/2026\/07\/a-capture-[0-9a-z]{8}\.md$/u);
    expect(result.commit.sha).toBe('sha1');

    // Index entry: identifiers + dedup keys only — never the title or the body.
    const indexFile = commit?.files.find((file) => file.path === indexPath());
    expect(indexFile).toBeDefined();
    const index = JSON.parse(indexFile?.content ?? '{}') as {
      items: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(index.items)).toEqual([SOURCE.id]);
    expect(index.items[SOURCE.id]).toMatchObject({ id: SOURCE.id, kind: 'source', path: result.path });
    expect(indexFile?.content).not.toContain('Body text');
    expect(indexFile?.content).not.toContain('A capture');
  });

  it('TC-F3-I01 merges into an existing index rather than replacing it', async () => {
    const existing = mergeIndex(emptyIndex(), [
      {
        id: 'old00001',
        kind: 'source',
        path: 'inbox/2026/01/old-old00001.md',
        created_at: '2026-01-05T08:30:00.000Z',
        updated_at: '2026-01-05T08:30:00.000Z',
      },
    ]);
    const api = fakeApi({
      readFile: async (path) => (path === indexPath() ? indexToFile(existing).content : null),
    });
    const result = await makeStore(api).commitRecord(SOURCE);
    expect(Object.keys(result.index.items).sort()).toEqual(['old00001', SOURCE.id].sort());
  });

  it('TC-F6-U02 refuses an empty or oversized commit', async () => {
    const store = makeStore(fakeApi());
    await expect(store.commitFiles([], 'nothing')).rejects.toThrow(/empty commit/u);
    // Derived from the constant, so the bound can move without the test quietly testing nothing.
    const many: RepoFile[] = Array.from({ length: MAX_COMMIT_FILES + 1 }, (_, index) => ({
      path: `x/${index}.md`,
      content: 'x',
    }));
    await expect(store.commitFiles(many, 'too many')).rejects.toThrow(
      new RegExp(`${MAX_COMMIT_FILES + 1} files`, 'u'),
    );
  });

  it('TC-F6-U01 builds a readable default commit message per kind', () => {
    expect(defaultCommitMessage(SOURCE)).toBe(`capture: A capture [${SOURCE.id}]`);
    const card = newKnowledgeCard({
      source_id: SOURCE.id,
      title: 'Card title',
      summary: 's',
      points: ['p'],
      evidence_paths: ['p'],
    });
    expect(defaultCommitMessage(card)).toBe(`distill: Card title [${card.id}]`);
    expect(defaultCommitMessage({ ...SOURCE, kind: 'topic', name: 'AI' } as never)).toContain('topic: AI');
  });

  it('TC-F6-U01 keeps the title out of the commit message in vault mode', () => {
    expect(defaultCommitMessage(SOURCE, 'vault')).toBe(`source: [${SOURCE.id}]`);
    expect(defaultCommitMessage(SOURCE, 'vault')).not.toContain('A capture');
  });
});

describe('index-driven queries (F6 UNIT)', () => {
  const indexed = mergeIndex(emptyIndex(), [
    {
      id: 'source01',
      kind: 'source',
      path: 'inbox/2026/07/page-source01.md',
      url_key: 'https://example.com/page',
      content_key: 'aaaa',
      created_at: '2026-07-01T00:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    },
    {
      id: 'source02',
      kind: 'source',
      path: 'inbox/2026/07/other-source02.md',
      url_key: 'https://example.com/other',
      content_key: 'bbbb',
      created_at: '2026-07-05T00:00:00.000Z',
      updated_at: '2026-07-05T00:00:00.000Z',
    },
    {
      id: 'card0001',
      kind: 'card',
      path: 'cards/pending/card-card0001.md',
      created_at: '2026-07-06T00:00:00.000Z',
      updated_at: '2026-07-06T00:00:00.000Z',
    },
  ]);

  function storeWithIndex(): GitHubStore {
    return makeStore(
      fakeApi({
        readFile: async (path) => (path === indexPath() ? indexToFile(indexed).content : null),
      }),
    );
  }

  it('TC-F6-U01 prefers a url match and falls back to the content key', async () => {
    const store = storeWithIndex();
    expect(await store.findExisting('https://example.com/page', 'zzzz')).toMatchObject({
      id: 'source01',
    });
    expect(await store.findExisting('https://example.com/new', 'bbbb')).toMatchObject({
      id: 'source02',
    });
    expect(await store.findExisting('https://example.com/new', 'zzzz')).toBeNull();
  });

  it('TC-F6-U01 lists the inbox and pending cards newest first', async () => {
    const store = storeWithIndex();
    expect((await store.listInbox()).map((item) => item.id)).toEqual(['source02', 'source01']);
    expect((await store.listPendingCards()).map((item) => item.id)).toEqual(['card0001']);
    expect((await store.listInbox(1)).map((item) => item.id)).toEqual(['source02']);
  });

  it('TC-F6-U01 treats a missing index as empty and reads a record back', async () => {
    const api = fakeApi({
      readFile: async (path) => {
        if (path === indexPath()) return null;
        if (path === 'inbox/2026/07/x.md') {
          return '---\nid: "abcd1234"\nkind: "source"\nchannel: "extension"\nurl: "https://e.com"\ntitle: "T"\ncaptured_at: "2026-07-09T00:00:00.000Z"\ncontent_hash: "aaaa"\ntags: []\n---\nbody';
        }
        return null;
      },
    });
    const store = makeStore(api);
    expect(await store.readIndex()).toEqual(emptyIndex());
    expect(await store.readRecord('inbox/2026/07/x.md')).toMatchObject({ id: 'abcd1234' });
    await expect(store.readRecord('missing.md')).rejects.toThrow(/no record at/u);
  });

  it('TC-F6-U01 forgets an index entry without touching content files', async () => {
    const commits: Array<{ files: RepoFile[] }> = [];
    const store = makeStore(
      fakeApi({
        readFile: async (path) => (path === indexPath() ? indexToFile(indexed).content : null),
        commitFiles: async (files) => {
          commits.push({ files });
          return { sha: 's', htmlUrl: 'u', paths: files.map((file) => file.path) };
        },
      }),
    );

    const next = await store.forgetRecord('source01');
    expect(Object.keys(next.items).sort()).toEqual(['card0001', 'source02']);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.files.map((file) => file.path)).toEqual([indexPath()]);

    // A no-op removal must not produce an empty commit.
    await store.forgetRecord('does-not-exist');
    expect(commits).toHaveLength(1);
  });
});

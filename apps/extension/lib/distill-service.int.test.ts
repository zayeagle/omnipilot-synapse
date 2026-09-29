import { describe, expect, it, vi } from 'vitest';

import { newSourceItem } from './core/ckf';
import { sourceItemToDoc } from './core/document';
import { indexPath, sourceItemPath } from './core/paths';
import { DistillService, assertEndpointTrusted, endpointHost, isDistillSkipped } from './distill-service';
import { resolveProvider } from './providers';
import { AiLedger, CaptureQueue } from './queues';
import { MessageError } from './messages';
import { MemoryStorageArea, DEFAULT_SETTINGS, type ExtensionSettings } from './settings-store';
import { transparentCodec } from './store/codec';
import { AuthError } from './store/errors';
import { GitHubStore } from './store/github-store';
import type { GithubApi } from './store/github-api';
import type { CommitResult, RepoFile, StoreProbe } from './store/types';

const PROBE: StoreProbe = {
  kind: 'github',
  repoFullName: 'zayeagle/omnipilot-synapse',
  visibility: 'private',
  defaultBranch: 'main',
  canPush: true,
  canWrite: true,
  checkedAt: '2026-07-09T00:00:00.000Z',
};

const FIXED_NOW = Date.parse('2026-07-09T01:00:00.000Z');
const SOURCE = newSourceItem({
  url: 'https://example.com/spaced-repetition',
  title: 'Spaced repetition',
  body: 'Reviewing near the point of forgetting is the most efficient schedule.',
  capturedAt: new Date('2026-07-09T00:00:00.000Z'),
});
const SOURCE_PATH = sourceItemPath(SOURCE);

function memoryApi(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const state = { commits: 0, commitFiles: [] as RepoFile[][] };
  const api: GithubApi = {
    probeRepo: async () => ({ ...PROBE }),
    readFile: async (path: string) => files.get(path) ?? null,
    listDir: async () => [],
    commitFiles: async (incoming: RepoFile[]): Promise<CommitResult> => {
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

const VALID_REPLY = JSON.stringify({
  title: 'Spaced repetition scheduling',
  summary: 'Review near the forgetting point.',
  points: ['Schedule by retrievability', 'Rate honestly', 'Shorten after a miss'],
});

function chatFetch(reply: string) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string, init: { headers?: Record<string, string>; body?: string }) => {
    calls.push({
      url,
      headers: init.headers ?? {},
      body: init.body ? (JSON.parse(init.body) as unknown) : undefined,
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fetchImpl, calls };
}

function makeSettings(overrides: Partial<ExtensionSettings['ai']> = {}, root: Partial<ExtensionSettings> = {}): ExtensionSettings {
  return {
    ...DEFAULT_SETTINGS,
    aiAuthorized: true,
    ...root,
    ai: { providerId: 'deepseek', model: 'deepseek-chat', baseUrl: '', trustedHosts: [], ...overrides },
  };
}

function makeService(options: {
  api: GithubApi;
  settings?: ExtensionSettings;
  ledger?: AiLedger;
  reply?: string;
  providerKey?: string;
}) {
  const store = new GitHubStore({
    api: options.api,
    codec: transparentCodec,
    repoFullName: 'zayeagle/omnipilot-synapse',
    branch: 'main',
    now: () => FIXED_NOW,
  });
  const ledger = options.ledger ?? new AiLedger(new MemoryStorageArea(), () => FIXED_NOW);
  const fetchStub = chatFetch(options.reply ?? VALID_REPLY);
  const service = new DistillService({
    store,
    ledger,
    settings: options.settings ?? makeSettings(),
    secrets: { githubPat: 'pat', providerKey: options.providerKey ?? 'sk-test-key-123456' },
    fetchImpl: fetchStub.fetchImpl,
    now: () => FIXED_NOW,
  });
  return { service, ledger, store, ...fetchStub };
}

describe('distillation gates (F7 UNIT)', () => {
  it('TC-F7-U05 refuses an un-authorized item without making any request', async () => {
    const { api } = memoryApi({ [SOURCE_PATH]: sourceItemToDoc(SOURCE) });
    const { service, fetchImpl } = makeService({ api });

    const result = await service.distill({ sourceId: SOURCE.id, sourcePath: SOURCE_PATH });

    expect(isDistillSkipped(result)).toBe(true);
    expect(result).toEqual({ skipped: 'not-authorized' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('TC-F7-U05 refuses when AI egress is globally off', async () => {
    const { api } = memoryApi({ [SOURCE_PATH]: sourceItemToDoc(SOURCE) });
    const ledger = new AiLedger(new MemoryStorageArea(), () => FIXED_NOW);
    await ledger.append({ source_id: SOURCE.id, provider: 'deepseek', model: 'deepseek-chat', ok: true });
    const { service, fetchImpl } = makeService({
      api,
      ledger,
      settings: makeSettings({}, { aiAuthorized: false }),
    });

    expect(await service.distill({ sourceId: SOURCE.id, sourcePath: SOURCE_PATH })).toEqual({
      skipped: 'not-authorized',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('TC-F7-U05 refuses when no provider key or model is configured', async () => {
    const { api } = memoryApi({ [SOURCE_PATH]: sourceItemToDoc(SOURCE) });
    const noModel = makeService({ api, settings: makeSettings({ model: '' }) });
    expect(await noModel.service.distill({ sourceId: SOURCE.id, sourcePath: SOURCE_PATH })).toEqual({
      skipped: 'no-provider-model',
    });

    const noKey = makeService({ api, providerKey: '' });
    expect(await noKey.service.distill({ sourceId: SOURCE.id, sourcePath: SOURCE_PATH })).toEqual({
      skipped: 'no-provider-key',
    });
    expect(noKey.fetchImpl).not.toHaveBeenCalled();
  });

  it('TC-F7-U05 allows an item the user authorized for this session', async () => {
    const { api, state } = memoryApi({ [SOURCE_PATH]: sourceItemToDoc(SOURCE) });
    const { service, fetchImpl } = makeService({ api });

    const result = await service.distill({
      sourceId: SOURCE.id,
      sourcePath: SOURCE_PATH,
      allowThisSession: true,
    });

    expect(isDistillSkipped(result)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(state.commits).toBe(1);
  });

  it('TC-F7-U05 refuses an unacknowledged custom endpoint before reading anything', async () => {
    const { api, state } = memoryApi({ [SOURCE_PATH]: sourceItemToDoc(SOURCE) });
    const ledger = new AiLedger(new MemoryStorageArea(), () => FIXED_NOW);
    await ledger.append({ source_id: SOURCE.id, provider: 'custom', model: 'm', ok: true });

    const { service, fetchImpl } = makeService({
      api,
      ledger,
      settings: makeSettings({
        providerId: 'custom',
        model: 'm',
        baseUrl: 'https://llm.internal/v1',
        trustedHosts: [],
      }),
    });

    await expect(service.distill({ sourceId: SOURCE.id, sourcePath: SOURCE_PATH })).rejects.toThrow(
      MessageError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state.commits).toBe(0);
  });

  it('TC-F7-U05 classifies endpoint hosts and trust decisions', () => {
    expect(endpointHost('https://llm.internal/v1')).toBe('llm.internal');
    expect(endpointHost('not a url')).toBe('');
    const provider = resolveProvider('custom');
    expect(() => assertEndpointTrusted(provider, 'not a url', [])).toThrow(/not a valid URL/u);
    expect(() => assertEndpointTrusted(provider, 'https://llm.internal/v1', [])).toThrow(/not been trusted/u);
    expect(() =>
      assertEndpointTrusted(provider, 'https://llm.internal/v1', ['llm.internal']),
    ).not.toThrow();
    // The catalog default never needs an acknowledgement.
    expect(() =>
      assertEndpointTrusted(resolveProvider('deepseek'), 'https://api.deepseek.com/v1', []),
    ).not.toThrow();
  });
});

describe('distillation end to end (F7 INT)', () => {
  it('TC-F7-I01 writes a pending card, leaves the source untouched and records the ledger', async () => {
    const sourceDoc = sourceItemToDoc(SOURCE);
    const { api, files, state } = memoryApi({
      [SOURCE_PATH]: sourceDoc,
      [indexPath()]: JSON.stringify({
        schema: 1,
        updated_at: '2026-07-09T00:00:00.000Z',
        items: {
          [SOURCE.id]: {
            id: SOURCE.id,
            kind: 'source',
            path: SOURCE_PATH,
            created_at: SOURCE.captured_at,
            updated_at: SOURCE.captured_at,
          },
        },
      }),
    });
    const ledger = new AiLedger(new MemoryStorageArea(), () => FIXED_NOW);
    await ledger.append({ source_id: SOURCE.id, provider: 'deepseek', model: 'deepseek-chat', ok: true });

    const { service, calls } = makeService({ api, ledger });
    const result = await service.distill({ sourceId: SOURCE.id, sourcePath: SOURCE_PATH });

    expect(isDistillSkipped(result)).toBe(false);
    if (isDistillSkipped(result)) throw new Error('unreachable');

    // The card lands under cards/pending and the commit also refreshes the index.
    expect(result.cardPath).toMatch(/^cards\/pending\/spaced-repetition-scheduling-[0-9a-z-]+\.md$/u);
    const committedPaths = state.commitFiles.flat().map((file) => file.path);
    expect(committedPaths).toContain(result.cardPath);
    expect(committedPaths).toContain(indexPath());

    // The source file is byte-identical: AI never rewrites the user's material.
    expect(files.get(SOURCE_PATH)).toBe(sourceDoc);
    const card = files.get(result.cardPath) ?? '';
    expect(card).toContain('status: "pending"');
    expect(card).toContain(`来源: ${SOURCE.id}`);
    expect(card).toContain('Schedule by retrievability');

    // The index gained the card without losing the source.
    expect(JSON.parse(files.get(indexPath()) ?? '{}').items).toHaveProperty(SOURCE.id);

    // Ledger: the authorization entry plus the successful outcome.
    const entries = await ledger.list();
    expect(entries[0]).toMatchObject({ source_id: SOURCE.id, ok: true, purpose: 'distill' });

    // One request, to the provider's endpoint, with the key in the header and the body in the prompt.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(calls[0]?.headers['Authorization']).toBe('Bearer sk-test-key-123456');
    expect(JSON.stringify(calls[0]?.body)).toContain('Spaced repetition');
  });

  it('TC-F7-I01 records a failed attempt and commits nothing', async () => {
    const { api, state } = memoryApi({ [SOURCE_PATH]: sourceItemToDoc(SOURCE) });
    const ledger = new AiLedger(new MemoryStorageArea(), () => FIXED_NOW);
    await ledger.append({ source_id: SOURCE.id, provider: 'deepseek', model: 'deepseek-chat', ok: true });

    const { service } = makeService({ api, ledger, reply: 'I am sorry, I cannot do that.' });

    await expect(service.distill({ sourceId: SOURCE.id, sourcePath: SOURCE_PATH })).rejects.toThrow(/no JSON object/u);
    expect(state.commits).toBe(0);
    const entries = await ledger.list();
    expect(entries[0]).toMatchObject({ source_id: SOURCE.id, ok: false, error_code: 'badJson' });
  });

  it('TC-F7-I01 surfaces a provider failure with the key scrubbed', async () => {
    const { api } = memoryApi({ [SOURCE_PATH]: sourceItemToDoc(SOURCE) });
    const ledger = new AiLedger(new MemoryStorageArea(), () => FIXED_NOW);
    await ledger.append({ source_id: SOURCE.id, provider: 'deepseek', model: 'deepseek-chat', ok: true });

    const store = new GitHubStore({
      api,
      codec: transparentCodec,
      repoFullName: 'zayeagle/omnipilot-synapse',
      branch: 'main',
    });
    const service = new DistillService({
      store,
      ledger,
      settings: makeSettings(),
      secrets: { githubPat: 'pat', providerKey: 'sk-secret-value-123456' },
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: 'invalid key sk-secret-value-123456' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      now: () => FIXED_NOW,
    });

    // Fixed, user-facing message — the provider's body (which echoed the key) never surfaces.
    let thrown: unknown;
    try {
      await service.distill({ sourceId: SOURCE.id, sourcePath: SOURCE_PATH });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('ai: the credential was rejected');
    expect((thrown as Error).message).not.toContain('sk-secret-value-123456');
    const entries = await ledger.list();
    expect(entries[0]?.ok).toBe(false);
    expect(entries[0]?.error_code).toBe('auth');
  });

  it('TC-F7-I01 refuses a non-source target', async () => {
    const cardPath = 'cards/pending/x.md';
    const cardDoc = [
      '---',
      'id: "card1234"',
      'kind: "card"',
      'source_id: "abcd1234"',
      'title: "T"',
      'summary: "s"',
      'points: ["p"]',
      'tags: []',
      'status: "pending"',
      'evidence_paths: ["p"]',
      '---',
      'body',
    ].join('\n');
    const { api, state } = memoryApi({ [cardPath]: cardDoc });
    const ledger = new AiLedger(new MemoryStorageArea(), () => FIXED_NOW);
    await ledger.append({ source_id: 'abcd1234', provider: 'deepseek', model: 'deepseek-chat', ok: true });

    const { service } = makeService({ api, ledger });
    await expect(
      service.distill({ sourceId: 'abcd1234', sourcePath: cardPath }),
    ).rejects.toThrow(/not a captured source/u);
    expect(state.commits).toBe(0);
  });

  it('TC-F7-I01 does not need a queue to function (distillation never queues)', async () => {
    const { api } = memoryApi({ [SOURCE_PATH]: sourceItemToDoc(SOURCE) });
    const queue = new CaptureQueue(new MemoryStorageArea(), () => FIXED_NOW);
    const ledger = new AiLedger(new MemoryStorageArea(), () => FIXED_NOW);
    await ledger.append({ source_id: SOURCE.id, provider: 'deepseek', model: 'deepseek-chat', ok: true });

    const { service } = makeService({ api, ledger });
    await service.distill({ sourceId: SOURCE.id, sourcePath: SOURCE_PATH });
    expect(await queue.size()).toBe(0);
    expect(AuthError).toBeDefined();
  });
});

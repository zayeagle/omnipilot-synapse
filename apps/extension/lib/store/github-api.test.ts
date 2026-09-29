import { describe, expect, it, vi } from 'vitest';

import { utf8ToBase64 } from '../security/base64';
import {
  AuthError,
  ConflictError,
  NetworkError,
  NotFoundError,
  NotConfiguredError,
  RateLimitError,
  ScopeError,
  StoreError,
  TimeoutError,
} from './errors';
import {
  DEFAULT_API_BASE,
  RETRY_BACKOFF_MS,
  createGithubApi,
  type FetchLike,
} from './github-api';

const OWNER = 'zayeagle';
const REPO = 'omnipilot-vault';
const BRANCH = 'main';
const TOKEN = 'github_pat_TCF6SECRET0000000000000000000';
const FIXED_NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
const API = DEFAULT_API_BASE;
const BASE = `${API}/repos/${OWNER}/${REPO}`;
const HTML = `https://github.com/${OWNER}/${REPO}`;

const HEAD_SHA = 'head-sha-1';
const BASE_TREE_SHA = 'base-tree-sha';
const NEW_TREE_SHA = 'new-tree-sha';
const COMMIT_SHA = 'commit-sha-1';

/** A route that answers every matching request. */
const ALWAYS = Number.POSITIVE_INFINITY;

interface StubCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface StubRoute {
  method: string;
  url: string | RegExp;
  status?: number;
  body?: unknown | ((call: StubCall) => unknown);
  /** How many requests this route answers before it is exhausted (default 1). */
  times?: number;
  /** Never answers — only an abort can end the request. */
  hang?: boolean;
  /** Throw instead of answering, simulating a transport failure. */
  rejectWith?: unknown;
}

function matchesUrl(target: string | RegExp, actual: string): boolean {
  return typeof target === 'string' ? target === actual : target.test(actual);
}

/** Minimal scripted transport: routes are matched in order, first match with budget wins. */
function makeFetchStub(routes: StubRoute[]) {
  const calls: StubCall[] = [];
  const remaining: number[] = routes.map((route) => route.times ?? 1);

  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const call: StubCall = {
      method,
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(call);

    const index = routes.findIndex(
      (route, i) =>
        (remaining[i] ?? 0) > 0 && route.method.toUpperCase() === method && matchesUrl(route.url, url),
    );
    if (index < 0) throw new Error(`unexpected request: ${method} ${url}`);
    remaining[index] = (remaining[index] ?? 1) - 1;
    const route = routes[index] as StubRoute;

    if (route.hang) {
      return new Promise<Response>((_resolve, reject) => {
        const abort = (): void => {
          reject(new Error('aborted'));
        };
        const signal = init.signal;
        if (signal?.aborted === true) abort();
        else signal?.addEventListener('abort', abort);
      });
    }
    if (route.rejectWith !== undefined) throw route.rejectWith;
    const payload =
      typeof route.body === 'function' ? (route.body as (call: StubCall) => unknown)(call) : route.body;
    return new Response(payload === undefined ? '' : JSON.stringify(payload), {
      status: route.status ?? 200,
    });
  });

  return { fetchImpl: fetchImpl as FetchLike, calls, mock: fetchImpl };
}

function makeApi(routes: StubRoute[], overrides: Partial<Parameters<typeof createGithubApi>[0]> = {}) {
  const stub = makeFetchStub(routes);
  const api = createGithubApi({
    fetchImpl: stub.fetchImpl,
    token: TOKEN,
    owner: OWNER,
    repo: REPO,
    branch: BRANCH,
    now: () => FIXED_NOW,
    ...overrides,
  });
  return { api, calls: stub.calls, fetchImpl: stub.mock };
}

function callList(calls: StubCall[]): string[] {
  return calls.map((call) => `${call.method} ${call.url}`);
}

/** The six requests every commit makes, reusable across the retry scenarios. */
function commitSequenceRoutes(): StubRoute[] {
  let blobCount = 0;
  return [
    {
      method: 'GET',
      url: `${BASE}/git/ref/heads/${BRANCH}`,
      body: { object: { sha: HEAD_SHA } },
      times: ALWAYS,
    },
    {
      method: 'GET',
      url: `${BASE}/git/commits/${HEAD_SHA}`,
      body: { tree: { sha: BASE_TREE_SHA } },
      times: ALWAYS,
    },
    {
      method: 'POST',
      url: `${BASE}/git/blobs`,
      body: () => ({ sha: `blob-sha-${(blobCount += 1)}` }),
      times: ALWAYS,
    },
    { method: 'POST', url: `${BASE}/git/trees`, body: { sha: NEW_TREE_SHA }, times: ALWAYS },
    {
      method: 'POST',
      url: `${BASE}/git/commits`,
      body: { sha: COMMIT_SHA, html_url: `${HTML}/commit/${COMMIT_SHA}` },
      times: ALWAYS,
    },
    {
      method: 'PATCH',
      url: `${BASE}/git/refs/heads/${BRANCH}`,
      body: { object: { sha: COMMIT_SHA } },
      times: ALWAYS,
    },
  ];
}

const EXPECTED_COMMIT_CALLS = [
  `GET ${BASE}/git/ref/heads/${BRANCH}`,
  `GET ${BASE}/git/commits/${HEAD_SHA}`,
  `POST ${BASE}/git/blobs`,
  `POST ${BASE}/git/blobs`,
  `POST ${BASE}/git/trees`,
  `POST ${BASE}/git/commits`,
  `PATCH ${BASE}/git/refs/heads/${BRANCH}`,
];

describe('commitFiles (F6 UNIT)', () => {
  it('TC-F6-U01 commits two files in one atomic Git Data sequence', async () => {
    const { api, calls, fetchImpl } = makeApi(commitSequenceRoutes());
    const files = [
      { path: 'inbox/2026/01/first.md', content: 'first body' },
      { path: 'index.json', content: '{"schema":1}' },
    ];

    const result = await api.commitFiles(files, 'capture: First [abc12345]');

    expect(callList(calls)).toEqual(EXPECTED_COMMIT_CALLS);
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    expect(result).toEqual({
      sha: COMMIT_SHA,
      htmlUrl: `${HTML}/commit/${COMMIT_SHA}`,
      paths: ['inbox/2026/01/first.md', 'index.json'],
    });

    const treeCall = calls[4];
    expect(treeCall?.body).toEqual({
      base_tree: BASE_TREE_SHA,
      tree: [
        { path: 'inbox/2026/01/first.md', mode: '100644', type: 'blob', sha: 'blob-sha-1' },
        { path: 'index.json', mode: '100644', type: 'blob', sha: 'blob-sha-2' },
      ],
    });
    expect(calls[2]?.body).toEqual({ content: 'first body', encoding: 'utf-8' });
    expect(calls[3]?.body).toEqual({ content: '{"schema":1}', encoding: 'utf-8' });
    expect(calls[5]?.body).toEqual({
      message: 'capture: First [abc12345]',
      tree: NEW_TREE_SHA,
      parents: [HEAD_SHA],
    });
    expect(calls[6]?.body).toEqual({ sha: COMMIT_SHA });
  });

  it('TC-F6-U01 sends the required headers on every request', async () => {
    const { api, calls } = makeApi(commitSequenceRoutes());
    await api.commitFiles([{ path: 'a.md', content: 'a' }], 'msg');

    for (const call of calls) {
      expect(call.headers).toMatchObject({
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${TOKEN}`,
      });
    }
    expect(calls[0]?.headers['Content-Type']).toBeUndefined();
    expect(calls[2]?.headers['Content-Type']).toBe('application/json');
  });

  it('TC-F6-U02 keeps the same sequence for a degenerate one-file commit', async () => {
    const { api, calls } = makeApi(commitSequenceRoutes());

    const result = await api.commitFiles([{ path: 'only.md', content: 'only' }], 'capture: Only');

    expect(callList(calls)).toEqual([
      `GET ${BASE}/git/ref/heads/${BRANCH}`,
      `GET ${BASE}/git/commits/${HEAD_SHA}`,
      `POST ${BASE}/git/blobs`,
      `POST ${BASE}/git/trees`,
      `POST ${BASE}/git/commits`,
      `PATCH ${BASE}/git/refs/heads/${BRANCH}`,
    ]);
    expect(calls[3]?.body).toEqual({
      base_tree: BASE_TREE_SHA,
      tree: [{ path: 'only.md', mode: '100644', type: 'blob', sha: 'blob-sha-1' }],
    });
    expect(result.paths).toEqual(['only.md']);
  });

  it('TC-F6-U02 rejects an empty file list before any network call', async () => {
    const { api, fetchImpl } = makeApi(commitSequenceRoutes());

    await expect(api.commitFiles([], 'capture: nothing')).rejects.toMatchObject({
      code: 'validation',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it('TC-F6-U02 rejects a file without a path before any network call', async () => {
    const { api, fetchImpl } = makeApi(commitSequenceRoutes());

    await expect(api.commitFiles([{ path: '', content: 'x' }], 'm')).rejects.toBeInstanceOf(
      StoreError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it('TC-F6-U06 retries the whole sequence once when the ref moved, then succeeds', async () => {
    const { api, calls, fetchImpl } = makeApi([
      // A route listed first wins while it still has budget, so the first PATCH conflicts.
      {
        method: 'PATCH',
        url: `${BASE}/git/refs/heads/${BRANCH}`,
        status: 409,
        body: { message: 'Update is not a fast forward' },
        times: 1,
      },
      ...commitSequenceRoutes(),
    ]);

    const result = await api.commitFiles([{ path: 'a.md', content: 'a' }], 'capture: A');

    expect(result.sha).toBe(COMMIT_SHA);
    expect(fetchImpl).toHaveBeenCalledTimes(12);
    expect(callList(calls).filter((entry) => entry.startsWith('GET'))).toEqual([
      `GET ${BASE}/git/ref/heads/${BRANCH}`,
      `GET ${BASE}/git/commits/${HEAD_SHA}`,
      `GET ${BASE}/git/ref/heads/${BRANCH}`,
      `GET ${BASE}/git/commits/${HEAD_SHA}`,
    ]);
    expect(callList(calls).at(-1)).toBe(`PATCH ${BASE}/git/refs/heads/${BRANCH}`);
  });

  it('TC-F6-U06 reports ConflictError when the ref moves twice', async () => {
    const { api, calls } = makeApi([
      {
        method: 'PATCH',
        url: `${BASE}/git/refs/heads/${BRANCH}`,
        status: 409,
        body: { message: 'Update is not a fast forward' },
        times: ALWAYS,
      },
      ...commitSequenceRoutes(),
    ]);

    await expect(api.commitFiles([{ path: 'a.md', content: 'a' }], 'm')).rejects.toBeInstanceOf(
      ConflictError,
    );
    // Exactly two full attempts: one initial sequence plus one retry.
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(2);
    expect(calls).toHaveLength(12);
  });

  it('TC-F6-U06 reports NotFoundError with a branch hint when the ref is missing', async () => {
    const { api, calls } = makeApi([
      {
        method: 'GET',
        url: `${BASE}/git/ref/heads/${BRANCH}`,
        status: 404,
        body: { message: 'Not Found' },
      },
    ]);

    const error = await api.commitFiles([{ path: 'a.md', content: 'a' }], 'm').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).message).toContain(BRANCH);
    expect((error as NotFoundError).hint).toMatch(/branch/iu);
    expect(callList(calls)).toEqual([`GET ${BASE}/git/ref/heads/${BRANCH}`]);
  });
});

describe('probeRepo (F6 UNIT)', () => {
  it('TC-F6-U03 classifies 401 and performs no write request', async () => {
    const { api, calls, fetchImpl } = makeApi([
      { method: 'GET', url: BASE, status: 401, body: { message: 'Bad credentials' } },
    ]);

    const error = await api.probeRepo().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).code).toBe('auth');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('TC-F6-U04 maps a 403 scope failure onto ScopeError with a Contents write hint', async () => {
    const { api } = makeApi([
      {
        method: 'GET',
        url: BASE,
        status: 403,
        body: { message: 'Resource not accessible by integration' },
      },
    ]);

    const error = await api.probeRepo().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScopeError);
    expect((error as ScopeError).code).toBe('scope');
    expect((error as ScopeError).hint).toMatch(/Contents/iu);
    expect((error as ScopeError).hint).toMatch(/write/iu);
  });

  it('TC-F6-U04 maps a 403 rate-limit body onto RateLimitError', async () => {
    const { api } = makeApi([
      {
        method: 'GET',
        url: BASE,
        status: 403,
        body: { message: 'API rate limit exceeded for user ID 1.' },
      },
    ]);

    const error = await api.probeRepo().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBeGreaterThan(0);
  });

  it('TC-F6-U05 reports a writable private repository without a warning', async () => {
    const { api } = makeApi([
      {
        method: 'GET',
        url: BASE,
        body: { private: true, default_branch: 'trunk', permissions: { push: true } },
      },
    ]);

    const probe = await api.probeRepo();

    expect(probe).toEqual({
      kind: 'github',
      repoFullName: `${OWNER}/${REPO}`,
      visibility: 'private',
      defaultBranch: 'trunk',
      canPush: true,
      canWrite: true,
      checkedAt: new Date(FIXED_NOW).toISOString(),
    });
    expect(probe.warning).toBeUndefined();
  });

  it('TC-F6-U05 hard-blocks a public repository even when the token can push', async () => {
    const { api } = makeApi([
      {
        method: 'GET',
        url: BASE,
        body: { private: false, default_branch: 'main', permissions: { push: true } },
      },
    ]);

    const probe = await api.probeRepo();

    expect(probe.visibility).toBe('public');
    expect(probe.canPush).toBe(true);
    expect(probe.canWrite).toBe(false);
    expect(probe.warning).toBe('public-repo');
  });

  it('TC-F6-U05 reports internal and unknown visibility without treating them as public', async () => {
    const internal = makeApi([
      { method: 'GET', url: BASE, body: { visibility: 'internal', permissions: { push: true } } },
    ]);
    const unknown = makeApi([{ method: 'GET', url: BASE, body: { permissions: { push: true } } }]);

    expect((await internal.api.probeRepo()).visibility).toBe('internal');
    const probe = await unknown.api.probeRepo();
    expect(probe.visibility).toBe('unknown');
    expect(probe.canWrite).toBe(true);
    expect(probe.defaultBranch).toBe(BRANCH);
  });
});

describe('readFile / listDir (F6 UNIT)', () => {
  it('TC-F6-U02 returns null for a missing file and sends the branch as ref', async () => {
    const { api, calls } = makeApi([
      { method: 'GET', url: /\/contents\/inbox\/gone\.md/u, status: 404, body: { message: 'Not Found' } },
    ]);

    await expect(api.readFile('inbox/gone.md')).resolves.toBeNull();
    expect(callList(calls)).toEqual([`GET ${BASE}/contents/inbox/gone.md?ref=${BRANCH}`]);
  });

  it('TC-F6-U02 decodes base64 file content and encodes spaces in the path', async () => {
    const body = '# 标题\n\nbody\n';
    const { api, calls } = makeApi([
      {
        method: 'GET',
        url: `${BASE}/contents/inbox/2026/01/hello%20world.md?ref=${BRANCH}`,
        body: { type: 'file', encoding: 'base64', content: utf8ToBase64(body) },
      },
    ]);

    await expect(api.readFile('inbox/2026/01/hello world.md')).resolves.toBe(body);
    expect(calls).toHaveLength(1);
  });

  it('TC-F6-U02 returns null when the path is a directory listing', async () => {
    const { api } = makeApi([
      { method: 'GET', url: /\/contents\/inbox/u, body: [{ name: 'a.md', path: 'inbox/a.md', sha: 's1', type: 'file' }] },
    ]);

    await expect(api.readFile('inbox')).resolves.toBeNull();
  });

  it('TC-F6-U02 returns an empty listing for a missing directory', async () => {
    const { api, fetchImpl } = makeApi([
      { method: 'GET', url: /\/contents\/nothing/u, status: 404, body: { message: 'Not Found' } },
    ]);

    await expect(api.listDir('nothing')).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('TC-F6-U02 maps directory entries and drops unusable ones', async () => {
    const { api } = makeApi([
      {
        method: 'GET',
        url: `${BASE}/contents/inbox?ref=${BRANCH}`,
        body: [
          {
            name: '2026',
            path: 'inbox/2026',
            sha: 'dir-sha',
            type: 'dir',
            // GitHub returns null content for a directory entry; the client must not decode it.
            content: null,
            encoding: 'none',
          },
          { name: 'a.md', path: 'inbox/a.md', sha: 'file-sha', type: 'file', content: utf8ToBase64('hi'), encoding: 'base64' },
          { name: 'submodule', path: 'inbox/sub', sha: 'sub-sha', type: 'submodule' },
          { name: 'broken', type: 'file' },
        ],
      },
    ]);

    await expect(api.listDir('inbox')).resolves.toEqual([
      { name: '2026', path: 'inbox/2026', sha: 'dir-sha', type: 'dir' },
      { name: 'a.md', path: 'inbox/a.md', sha: 'file-sha', type: 'file' },
    ]);
  });

  it('TC-F6-U02 lists the repository root without a path segment', async () => {
    const { api, calls } = makeApi([{ method: 'GET', url: `${BASE}/contents?ref=${BRANCH}`, body: [] }]);

    await expect(api.listDir('')).resolves.toEqual([]);
    expect(callList(calls)).toEqual([`GET ${BASE}/contents?ref=${BRANCH}`]);
  });
});

describe('transport policy (F6 UNIT)', () => {
  it('TC-F6-U06 turns an aborted request into TimeoutError', async () => {
    const { api, calls } = makeApi([{ method: 'GET', url: BASE, hang: true }], { timeoutMs: 20 });

    await expect(api.probeRepo()).rejects.toBeInstanceOf(TimeoutError);
    expect(calls).toHaveLength(1);
  });

  it('TC-F6-U04 retries once on 429 and then succeeds', async () => {
    vi.useFakeTimers();
    try {
      const { api, fetchImpl } = makeApi([
        { method: 'GET', url: BASE, status: 429, body: { message: 'rate limited' }, times: 1 },
        {
          method: 'GET',
          url: BASE,
          body: { private: true, default_branch: 'main', permissions: { push: true } },
        },
      ]);

      const pending = api.probeRepo();
      await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS + 50);
      const probe = await pending;

      expect(probe.visibility).toBe('private');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('TC-F6-U04 gives up after one retry when 5xx persists', async () => {
    vi.useFakeTimers();
    try {
      const { api, fetchImpl } = makeApi([
        { method: 'GET', url: BASE, status: 503, body: { message: 'Server Error' }, times: ALWAYS },
      ]);

      const pending = api.probeRepo();
      const assertion = expect(pending).rejects.toMatchObject({ code: 'network', status: 503 });
      await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS + 50);
      await assertion;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('TC-F6-U04 does not retry a plain 4xx', async () => {
    const { api, fetchImpl } = makeApi([
      { method: 'GET', url: BASE, status: 403, body: { message: 'Resource not accessible' } },
    ]);

    await expect(api.probeRepo()).rejects.toBeInstanceOf(ScopeError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('TC-F6-U03 never leaks the token into an error message', async () => {
    const { api } = makeApi([
      {
        method: 'GET',
        url: BASE,
        status: 401,
        body: { message: `Bad credentials: Bearer ${TOKEN}` },
      },
    ]);

    const error = (await api.probeRepo().catch((e: unknown) => e)) as AuthError;

    expect(error).toBeInstanceOf(AuthError);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain('Bad credentials');
  });

  it('TC-F6-U03 scrubs the token out of a transport failure', async () => {
    const { api } = makeApi([
      { method: 'GET', url: BASE, rejectWith: new Error(`connect failed for Bearer ${TOKEN}`) },
    ]);

    const error = (await api.probeRepo().catch((e: unknown) => e)) as NetworkError;

    expect(error).toBeInstanceOf(NetworkError);
    expect(error.message).not.toContain(TOKEN);
  });

  it('TC-F6-U03 refuses to build a request without owner, repo, branch and token', async () => {
    const blankToken = makeApi([], { token: '   ' });
    const blankOwner = makeApi([], { owner: '' });

    await expect(blankToken.api.probeRepo()).rejects.toBeInstanceOf(NotConfiguredError);
    await expect(blankOwner.api.commitFiles([{ path: 'a.md', content: 'a' }], 'm')).rejects.toBeInstanceOf(
      NotConfiguredError,
    );
    expect(blankToken.fetchImpl).toHaveBeenCalledTimes(0);
    expect(blankOwner.fetchImpl).toHaveBeenCalledTimes(0);
  });

  it('TC-F6-U03 reports an unexpected response shape without echoing the body', async () => {
    const { api } = makeApi([
      { method: 'GET', url: `${BASE}/git/ref/heads/${BRANCH}`, body: { token_echo: TOKEN } },
    ]);

    const error = (await api.commitFiles([{ path: 'a.md', content: 'a' }], 'm').catch(
      (e: unknown) => e,
    )) as StoreError;

    expect(error).toBeInstanceOf(StoreError);
    expect(error.code).toBe('unknown');
    expect(error.message).not.toContain(TOKEN);
  });
});

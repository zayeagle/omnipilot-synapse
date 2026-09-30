import { describe, expect, it, vi } from 'vitest';

import { createHandlers, scrubHandlerError, type BackgroundContext } from './handlers';
import { MessageRouter, createRouterOptions } from './router';
import { PAGE_CLIP_MESSAGE, type ExtensionResponse } from '../messages';
import { AiLedger, CaptureQueue } from '../queues';
import { MIN_ITERATIONS } from '../security/crypto-key';
import { KeySession, MemorySessionKeyStore } from '../security/key-session';
import { MemoryStorageArea, STORAGE_KEYS, SettingsStore } from '../settings-store';
import type { StatusData } from '../status';

const OPTIONS_SENDER = { url: 'chrome-extension://abcdefghijklmnop/options.html' };
const PAGE_SENDER = { tab: { id: 5, url: 'https://evil.test/' }, url: 'https://evil.test/' };
const PASSPHRASE = 'correct horse battery';
const PAT = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop';
const MODEL_KEY = 'sk-model-key-abcdefghijklmnop';
const FIXED_NOW = Date.parse('2026-07-09T00:00:00.000Z');

const LONG_BODY = 'Body text for the captured page. '.repeat(20);

/** The proposal as the popup sees it (see `cards.list`). */
interface ListCard {
  id: string;
  path: string;
  title: string;
  summary: string;
  points: string[];
  tags: string[];
}

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

/**
 * One stub that answers both the GitHub REST sequence and a chat completion.
 *
 * It keeps a small in-memory repository (blob sha → content, tree → paths) so a second capture
 * genuinely re-reads the index it wrote, which is what makes the duplicate path testable.
 */
function stubFetch(options: { private?: boolean; reply?: string } = {}) {
  const calls: Recorded[] = [];
  let commits = 0;
  const blobBySha = new Map<string, string>();
  const files = new Map<string, string>();
  let pendingTree: Array<{ path: string; sha: string }> = [];

  const fetchImpl = async (input: string, init: RequestInit): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const url = String(input);
    let body: unknown;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, body });
    const json = (data: unknown, status = 200): Response =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    if (url.startsWith('https://api.deepseek.com')) {
      return json({
        choices: [
          {
            message: {
              content:
                options.reply ??
                JSON.stringify({
                  title: 'Distilled card',
                  summary: 'A summary.',
                  points: ['one', 'two', 'three'],
                }),
            },
          },
        ],
      });
    }

    if (method === 'GET' && /\/repos\/[^/]+\/[^/]+$/u.test(url)) {
      return json({
        full_name: 'zayeagle/omnipilot-synapse',
        private: options.private ?? true,
        default_branch: 'main',
        permissions: { push: true },
      });
    }
    if (method === 'GET' && url.includes('/contents/')) {
      const path = decodeURIComponent(url.split('/contents/')[1]?.split('?')[0] ?? '');
      const content = files.get(path);
      if (content === undefined) return json({ message: 'Not Found' }, 404);
      return json({
        type: 'file',
        path,
        sha: `sha-${path}`,
        encoding: 'base64',
        content: Buffer.from(content, 'utf8').toString('base64'),
      });
    }
    if (method === 'GET' && url.includes('/git/ref/heads/')) return json({ object: { sha: 'headsha' } });
    if (method === 'GET' && url.includes('/git/commits/headsha')) return json({ tree: { sha: 'basetree' } });
    if (method === 'POST' && url.endsWith('/git/blobs')) {
      const sha = `blob${blobBySha.size + 1}`;
      blobBySha.set(sha, String((body as { content?: string }).content ?? ''));
      return json({ sha });
    }
    if (method === 'POST' && url.endsWith('/git/trees')) {
      pendingTree = (body as { tree?: Array<{ path: string; sha: string }> }).tree ?? [];
      return json({ sha: 'treesha' });
    }
    if (method === 'POST' && url.endsWith('/git/commits')) {
      for (const entry of pendingTree) {
        const content = blobBySha.get(entry.sha);
        if (content !== undefined) files.set(entry.path, content);
      }
      commits += 1;
      return json({
        sha: `commit${commits}`,
        html_url: `https://github.com/zayeagle/omnipilot-synapse/commit/commit${commits}`,
      });
    }
    if (method === 'PATCH' && url.includes('/git/refs/heads/')) return json({ object: { sha: 'commit1' } });
    return json({ message: `unhandled ${method} ${url}` }, 500);
  };

  return { fetchImpl, calls, files, commitCount: () => commits };
}

function makeWorker(options: { private?: boolean; reply?: string } = {}) {
  const area = new MemoryStorageArea();
  const session = new KeySession({
    store: new MemorySessionKeyStore(),
    now: () => FIXED_NOW,
    ttlMs: 60 * 60 * 1000,
  });
  const settings = new SettingsStore({
    area,
    session,
    iterations: MIN_ITERATIONS,
    now: () => FIXED_NOW,
  });
  const queue = new CaptureQueue(area, () => FIXED_NOW);
  const ledger = new AiLedger(area, () => FIXED_NOW);
  const fetchStub = stubFetch(options);
  const pageClip = vi.fn(async () => true);

  const context: BackgroundContext = {
    settings,
    queue,
    ledger,
    session,
    fetchImpl: fetchStub.fetchImpl,
    now: () => FIXED_NOW,
    activeTab: async () => ({ id: 42, url: 'https://example.com/article' }),
    pageClip,
  };

  const router = new MessageRouter(
    createRouterOptions(createHandlers(context), {
      secrets: async () => {
        const secrets = await settings.peekSecrets();
        return secrets ? [secrets.githubPat, secrets.providerKey] : [];
      },
    }),
  );

  return { area, session, settings, queue, ledger, router, pageClip, ...fetchStub };
}
/**
 * R7/R8 — the authorization mode and the content tier are contracts, not picker decoration.
 *
 * The tier half is the security-relevant one: the repository's own record must win over this
 * installation's setting, or one client can write plaintext into another client's encrypted store.
 */
describe('authorization mode + content tier integrity (R7/R8 INT)', () => {
  it('TC-R7-I01 an SSH-only configuration fails about the companion, never about a missing token', async () => {
    const worker = makeWorker();
    await send(worker, 'vault.setup', { passphrase: PASSPHRASE });
    const saved = await send(worker, 'settings.github', {
      owner: 'zayeagle',
      repo: 'omnipilot-synapse',
      branch: 'main',
      ssh: { repoRoot: '/srv/kb' },
    });
    expect(saved.ok).toBe(true);
    expect((await send(worker, 'settings.security', { authMode: 'ssh' })).ok).toBe(true);

    // No PAT is stored and this harness has no companion. Before R7 every one of these failed with
    // `notConfigured` ('add a token') while the status surface said the user was configured; now the
    // resolution reaches the auth layer and reports the actionable fact.
    const listed = await send(worker, 'cards.list', { limit: 5 });
    expect(listed.ok).toBe(false);
    if (listed.ok) throw new Error('unreachable');
    expect(listed.code).toBe('nativeUnavailable');
  });

  it('TC-R8-I02 a tier change is refused while the repository holds content, and recorded while it is empty', async () => {
    const worker = await configuredWorker();
    const captured = await send(worker, 'capture.request', {
      mode: 'selection',
      url: 'https://example.com/article',
      title: 'A source',
      selection: LONG_BODY,
    });
    expect(captured.ok).toBe(true);

    const refused = await send(worker, 'settings.security', { securityMode: 'vault' });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.code).toBe('tierLocked');
    // The settings must not have moved either: a refused change is refused everywhere.
    const prefs = await send(worker, 'prefs.get');
    expect(prefs.ok).toBe(true);
    if (!prefs.ok) throw new Error('unreachable');
    expect((prefs.data as { securityMode?: string }).securityMode).toBe('transparent');

    // An empty repository can still be told what tier it is: that is the first-run choice.
    const empty = await configuredWorker();
    expect((await send(empty, 'settings.security', { securityMode: 'vault' })).ok).toBe(true);
    expect(empty.files.get('.omnipilot/config.json') ?? '').toContain('"security_mode": "vault"');
  });

  it('TC-R8-I01 the repository record wins over the local setting when the two disagree', async () => {
    const worker = await configuredWorker();
    // This installation says transparent (the default); the repository says vault.
    worker.files.set(
      '.omnipilot/config.json',
      JSON.stringify(
        {
          schema_version: 1,
          security_mode: 'vault',
          created_at: '2026-07-09T00:00:00.000Z',
          updated_at: '2026-07-09T00:00:00.000Z',
        },
        null,
        2,
      ) + '\n',
    );

    const captured = await send(worker, 'capture.request', {
      mode: 'selection',
      url: 'https://example.com/secret',
      title: 'A private source',
      selection: LONG_BODY,
    });
    expect(captured.ok).toBe(true);
    if (!captured.ok) throw new Error('unreachable');
    const path = (captured.data as { path: string }).path;
    // Vault mode names the file opaquely and encrypts the body — a plaintext write here would be a
    // silent downgrade of a repository another client reads as encrypted (SC-R8-01).
    expect(path.endsWith('.enc')).toBe(true);
    expect(worker.files.get(path) ?? '').not.toContain(LONG_BODY.slice(0, 40));
  });
});

async function send(
  worker: ReturnType<typeof makeWorker>,
  type: string,
  payload?: unknown,
  sender: unknown = OPTIONS_SENDER,
): Promise<ExtensionResponse> {
  return worker.router.handle({ type, payload }, sender as never);
}

async function configuredWorker(options: { private?: boolean; reply?: string } = {}) {
  const worker = makeWorker(options);
  await send(worker, 'vault.setup', { passphrase: PASSPHRASE });
  const saved = await send(worker, 'settings.github', {
    owner: 'zayeagle',
    repo: 'omnipilot-synapse',
    branch: 'main',
    pat: PAT,
    ...(options.private === false ? { publicRepoAcknowledged: true } : {}),
  });
  expect(saved.ok).toBe(true);
  return worker;
}

describe('background worker surface (F8 INT)', () => {
  it('TC-F8-I01 saves GitHub settings, probes them and reports status without secrets', async () => {
    const worker = await configuredWorker();

    const status = await send(worker, 'status.get');
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error('unreachable');
    const data = status.data as StatusData;

    expect(data.prefs).toMatchObject({
      repoFullName: 'zayeagle/omnipilot-synapse',
      hasPat: true,
      // A brand-new store now defaults to the readable tier (see 04-design F6).
      securityMode: 'transparent',
      vaultLocked: false,
    });
    expect(data.probe).toMatchObject({ visibility: 'private', canPush: true, canWrite: true });
    expect(data.vault).toMatchObject({ configured: true, unlocked: true });

    // The whole response — and everything persisted — must be free of credential material.
    const serialized = JSON.stringify(data) + JSON.stringify(worker.area.keys());
    expect(serialized).not.toContain(PAT);
    expect(serialized).not.toContain(PASSPHRASE);

    const stored = await worker.area.get([STORAGE_KEYS.secretVault, STORAGE_KEYS.publicPrefs]);
    expect(JSON.stringify(stored)).not.toContain(PAT);
  });

  it('TC-F8-I01 refuses to save a public repository until the risk is acknowledged', async () => {
    const worker = makeWorker({ private: false });
    await send(worker, 'vault.setup', { passphrase: PASSPHRASE });

    const refused = await send(worker, 'settings.github', {
      owner: 'zayeagle',
      repo: 'omnipilot-synapse',
      branch: 'main',
      pat: PAT,
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.code).toBe('publicRepo');

    const accepted = await send(worker, 'settings.github', {
      owner: 'zayeagle',
      repo: 'omnipilot-synapse',
      branch: 'main',
      pat: PAT,
      publicRepoAcknowledged: true,
    });
    expect(accepted.ok).toBe(true);
  });

  it('TC-F8-I01 captures a page and reports a duplicate on the second attempt', async () => {
    const worker = await configuredWorker();

    const first = await send(worker, 'capture.request', {
      mode: 'page',
      url: 'https://example.com/article',
      title: 'An article',
      body: LONG_BODY,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');
    expect(first.data).toMatchObject({ duplicate: false });
    // `queued` is only present when the capture had to be deferred.
    expect((first.data as { queued?: boolean }).queued).toBeUndefined();
    expect(worker.commitCount()).toBe(1);

    const second = await send(worker, 'capture.request', {
      mode: 'page',
      url: 'https://example.com/article?utm_source=x',
      title: 'An article',
      body: LONG_BODY,
    });
    expect(second.ok).toBe(true);
    expect(second.ok && second.data).toMatchObject({ duplicate: true });
    expect(worker.commitCount()).toBe(1);
  });

  it('TC-F5-I02 persists the chosen auth mode through settings.security', async () => {
    const worker = await configuredWorker();

    const saved = await send(worker, 'settings.security', { authMode: 'ssh' });
    expect(saved.ok && (saved.data as { authMode?: string }).authMode).toBe('ssh');

    // The value must be *stored*, not merely echoed: a reload must show the same picker state.
    const prefs = await send(worker, 'prefs.get');
    expect(prefs.ok && (prefs.data as { authMode?: string }).authMode).toBe('ssh');

    await send(worker, 'settings.security', { authMode: 'token' });
    const back = await send(worker, 'prefs.get');
    expect(back.ok && (back.data as { authMode?: string }).authMode).toBe('token');
  });

  /** Capture a page and let the stubbed model propose one card. Returns the pending card as listed. */
  async function distilledCard(worker: ReturnType<typeof makeWorker>) {
    await send(worker, 'settings.security', { aiAuthorized: true });
    await send(worker, 'settings.provider', {
      providerId: 'deepseek',
      model: 'deepseek-chat',
      apiKey: MODEL_KEY,
    });
    const captured = await send(worker, 'capture.request', {
      mode: 'page',
      url: 'https://example.com/article',
      title: 'An article',
      body: LONG_BODY,
      distill: true,
    });
    expect(captured.ok).toBe(true);

    const listed = await send(worker, 'cards.list', {});
    expect(listed.ok).toBe(true);
    const cards = listed.ok ? (listed.data as { cards: ListCard[] }).cards : [];
    expect(cards).toHaveLength(1);
    return cards[0]!;
  }

  it('TC-P7-I03 an empty review queue is an empty list, never an error', async () => {
    // Before any card is accepted there is no `review/state.json` at all. The tolerant reader must turn that
    // into "nothing is due" — a missing schedule is a state, not a failure (and a failure here would show the
    // user a broken queue on a brand-new install).
    const worker = await configuredWorker();
    const due = await send(worker, 'review.due');
    expect(due.ok).toBe(true);
    if (!due.ok) throw new Error('unreachable');
    expect((due.data as { due: unknown[] }).due).toEqual([]);
  });

  it('TC-P3-I01 an accepted proposal leaves pending, in exactly one commit, with the old path signposted', async () => {
    const worker = await configuredWorker();
    const card = await distilledCard(worker);

    // Before this requirement a card was written to the repository and could not even be listed.
    expect(card.title).toBe('Distilled card');
    expect(card.summary).toBe('A summary.');
    expect(card.points).toHaveLength(3);
    expect(card.path.startsWith('cards/pending/')).toBe(true);

    const commitsBefore = worker.commitCount();
    const decided = await send(worker, 'card.decide', {
      id: card.id,
      path: card.path,
      action: 'accept',
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) throw new Error('unreachable');
    const result = decided.data as { path: string; previousPath: string };

    // One commit for the whole decision: card + manifest + shards.
    expect(worker.commitCount()).toBe(commitsBefore + 1);
    expect(result.previousPath).toBe(card.path);
    expect(result.path).not.toBe(card.path);
    expect(result.path.startsWith('cards/')).toBe(true);
    expect(worker.files.get(result.path) ?? '').toContain('Distilled card');
    // The manifest follows the file, so disk and index cannot disagree.
    expect(worker.files.get('index.json') ?? '').toContain(result.path);
    // The old location is a signpost, not a copy of the note.
    expect(worker.files.get(card.path) ?? '').toContain('omnipilot:tombstone');
    expect(worker.files.get(card.path) ?? '').not.toContain('A summary.');

    // Accepting is also when the card becomes reviewable: `review/state.json` gets its first real entry.
    // Before this requirement the `ReviewState` type had existed for three releases without any production
    // writer, so the whole review stage was a data shape and nothing else (audit U2).
    const review = JSON.parse(worker.files.get('review/state.json') ?? '{}') as {
      items?: Record<string, { kind?: string; next_review_at?: string; use_count?: number }>;
    };
    expect(review.items?.[card.id]).toMatchObject({ kind: 'review', use_count: 0 });

    // …and the queue can read it back: writing without reading was the state of the review stage until now.
    const due = await send(worker, 'review.due');
    expect(due.ok && (due.data as { due: Array<{ id: string }> }).due.map((entry) => entry.id)).toContain(
      card.id,
    );
    expect(typeof review.items?.[card.id]?.next_review_at).toBe('string');

    // And it is gone from the proposals list — the loop is closed, not just recorded.
    const after = await send(worker, 'cards.list', {});
    expect(after.ok && (after.data as { cards: unknown[] }).cards).toHaveLength(0);

    // A second decision about the same card is refused rather than guessed at.
    const again = await send(worker, 'card.decide', {
      id: card.id,
      path: card.path,
      action: 'accept',
    });
    expect(again.ok).toBe(false);
  });

  it('TC-P3-I03 a discarded proposal is archived, unindexed, and nothing is destroyed', async () => {
    const worker = await configuredWorker();
    const card = await distilledCard(worker);

    const commitsBefore = worker.commitCount();
    const discarded = await send(worker, 'card.decide', {
      id: card.id,
      path: card.path,
      action: 'discard',
    });
    expect(discarded.ok).toBe(true);
    if (!discarded.ok) throw new Error('unreachable');
    const { archivedPath } = discarded.data as { archivedPath: string };

    expect(worker.commitCount()).toBe(commitsBefore + 1);
    expect(archivedPath.startsWith('archive/cards/')).toBe(true);
    // The body still exists, unindexed, under the archive — "discard" never means "delete".
    expect(worker.files.get(archivedPath) ?? '').toContain('Distilled card');
    expect(worker.files.get(card.path) ?? '').toContain('omnipilot:tombstone');
    expect(worker.files.get('index.json') ?? '').not.toContain(card.id);
    expect(worker.files.get('index.json') ?? '').not.toContain(archivedPath);
  });

  it('TC-P3-U02 an edited proposal keeps the AI text that was not rewritten', async () => {
    const worker = await configuredWorker();
    const card = await distilledCard(worker);

    const edited = await send(worker, 'card.decide', {
      id: card.id,
      path: card.path,
      action: 'edit',
      patch: { summary: 'my own words' },
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) throw new Error('unreachable');
    const body = worker.files.get((edited.data as { path: string }).path) ?? '';
    expect(body).toContain('my own words');
    // The parts the human did not touch are still the model's, and the card is still a proposal.
    expect(body).toContain('one');
    expect(await send(worker, 'cards.list', {})).toMatchObject({ ok: true });
  });

  it('TC-F8-I01 distils in the same round trip when asked and authorized', async () => {
    const worker = await configuredWorker();
    await send(worker, 'settings.security', { aiAuthorized: true });
    await send(worker, 'settings.provider', {
      providerId: 'deepseek',
      model: 'deepseek-chat',
      apiKey: MODEL_KEY,
    });

    const captured = await send(worker, 'capture.request', {
      mode: 'page',
      url: 'https://example.com/article',
      title: 'An article',
      body: LONG_BODY,
      distill: true,
    });

    expect(captured.ok).toBe(true);
    if (!captured.ok) throw new Error('unreachable');
    const data = captured.data as { distill: { cardPath: string } | null; distillSkipped?: string };
    // Clicking 提炼 in the capture flow is itself the per-item authorization, so the card is written
    // without a second prompt — while the global switch was still required to be on.
    expect(data.distill).not.toBeNull();
    expect(data.distill?.cardPath).toMatch(/^cards\/pending\//u);
    expect(data.distillSkipped).toBeUndefined();
    // Two commits: the source (record + index) and the card (record + index).
    expect(worker.commitCount()).toBe(2);

    // The provider key is stored only in the vault.
    const stored = JSON.stringify(await worker.area.get([STORAGE_KEYS.settings, STORAGE_KEYS.secretVault]));
    expect(stored).not.toContain(MODEL_KEY);
    expect(await worker.settings.publicPrefs()).toMatchObject({ hasKey: true });

    // …and it never appears in the request bodies that left the extension.
    const providerCalls = worker.calls.filter((call) => call.url.startsWith('https://api.deepseek.com'));
    expect(providerCalls).toHaveLength(1);
    expect(JSON.stringify(providerCalls[0]?.body)).not.toContain(MODEL_KEY);
    expect(await worker.ledger.size()).toBe(1);
  });

  it('TC-F8-I01 skips distillation when AI egress is globally off, but still captures', async () => {
    const worker = await configuredWorker();

    const captured = await send(worker, 'capture.request', {
      mode: 'page',
      url: 'https://example.com/ai-off',
      title: 'AI off',
      body: LONG_BODY,
      distill: true,
    });

    expect(captured.ok).toBe(true);
    if (!captured.ok) throw new Error('unreachable');
    expect((captured.data as { distillSkipped?: string }).distillSkipped).toBe('not-authorized');
    expect(worker.calls.some((call) => call.url.startsWith('https://api.deepseek.com'))).toBe(false);
  });

  it('TC-F8-I01 routes capture.page through the active tab', async () => {
    const worker = await configuredWorker();
    const response = await send(worker, 'capture.page', { distill: false });

    expect(response.ok).toBe(true);
    expect(worker.pageClip).toHaveBeenCalledWith(42, false);
  });

  it('TC-F8-I01 reports an unreachable page instead of pretending to clip it', async () => {
    const worker = await configuredWorker();
    worker.pageClip.mockResolvedValueOnce(false);

    const response = await send(worker, 'capture.page', {});
    expect(response.ok).toBe(false);
    expect(response.ok === false && response.error).toMatch(/did not accept/u);
  });

  it('TC-F8-I01 fails closed once the vault is locked', async () => {
    const worker = await configuredWorker();
    expect((await send(worker, 'vault.lock')).ok).toBe(true);

    const status = await send(worker, 'status.get');
    expect(status.ok).toBe(true);
    expect((status.ok && (status.data as StatusData).vault.unlocked)).toBe(false);

    const capture = await send(worker, 'capture.request', {
      mode: 'page',
      url: 'https://example.com/locked',
      title: 'Locked',
      body: LONG_BODY,
    });
    expect(capture.ok).toBe(false);
    expect(capture.ok === false && capture.code).toBe('locked');
    expect(worker.commitCount()).toBe(0);

    // Unlocking with the right passphrase restores access.
    expect((await send(worker, 'vault.unlock', { passphrase: PASSPHRASE })).ok).toBe(true);
    const retry = await send(worker, 'capture.request', {
      mode: 'page',
      url: 'https://example.com/locked',
      title: 'Locked',
      body: LONG_BODY,
    });
    expect(retry.ok).toBe(true);
  });

  it('TC-F8-I01 rejects a wrong passphrase without unlocking', async () => {
    const worker = await configuredWorker();
    await send(worker, 'vault.lock');

    const wrong = await send(worker, 'vault.unlock', { passphrase: 'not the passphrase' });
    expect(wrong.ok).toBe(false);
    expect(wrong.ok === false && wrong.code).toBe('wrongPassphrase');
    expect((await worker.settings.vaultStatus()).unlocked).toBe(false);
  });

  it('TC-F8-I01 keeps the ledger content-free and clearable', async () => {
    const worker = await configuredWorker();
    await worker.ledger.append({ source_id: 'abcd1234', provider: 'deepseek', model: 'deepseek-chat', ok: true });

    const listed = await send(worker, 'ai.ledger', { limit: 5 });
    expect(listed.ok).toBe(true);
    const serialized = JSON.stringify(listed.ok && listed.data);
    expect(serialized).toContain('abcd1234');
    expect(serialized).not.toContain(LONG_BODY);

    expect((await send(worker, 'ai.ledger.clear')).ok).toBe(true);
    expect(await worker.ledger.size()).toBe(0);
  });

  it('TC-F8-I01 never lets a page context reach a credential-bearing request', async () => {
    const worker = await configuredWorker();
    for (const type of ['settings.github', 'settings.provider', 'vault.unlock', 'store.probe', 'distill.request']) {
      const response = await send(worker, type, {}, PAGE_SENDER);
      expect(response.ok).toBe(false);
      expect(response.ok === false && response.code).toBe('auth');
    }
    // …while the two the content script genuinely needs still work.
    expect((await send(worker, 'prefs.get', undefined, PAGE_SENDER)).ok).toBe(true);
    expect((await send(worker, 'prefs.get', undefined, PAGE_SENDER)).ok).toBe(true);
  });

  it('TC-F8-I01 resets everything and scrubs handler errors', async () => {
    const worker = await configuredWorker();
    expect((await send(worker, 'settings.reset')).ok).toBe(true);
    expect(worker.area.keys()).toEqual([]);
    expect(await worker.settings.publicPrefs()).toMatchObject({ hasPat: false, repoFullName: '' });

    const message = await scrubHandlerError(new Error(`boom ${PAT}`), { settings: worker.settings });
    expect(message).not.toContain(PAT);
  });

  it('TC-F8-I01 rejects malformed payloads without touching the network', async () => {
    const worker = await configuredWorker();
    const before = worker.calls.length;

    expect((await send(worker, 'settings.provider', { providerId: '', model: '' })).ok).toBe(false);
    expect((await send(worker, 'settings.github', { owner: 'a b', repo: 'r', branch: 'main' })).ok).toBe(false);
    expect((await send(worker, 'capture.request', { mode: 'psychic', url: 'u', title: 't' })).ok).toBe(false);
    expect((await send(worker, 'vault.unlock', {})).ok).toBe(false);

    expect(worker.calls.length).toBe(before);
    expect(PAGE_CLIP_MESSAGE).toBe('page.clip');
  });
});

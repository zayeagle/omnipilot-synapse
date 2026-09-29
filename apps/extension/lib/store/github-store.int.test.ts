import { describe, expect, it } from 'vitest';

import { newSourceItem } from '../core/ckf';
import { indexPath } from '../core/paths';
import {
  MIN_ITERATIONS,
  deriveKeyFromEnvelope,
  createEnvelope,
  type EncryptedEnvelope,
} from '../security/crypto-key';
import { KeySession, MemorySessionKeyStore } from '../security/key-session';
import { createGitHubStore } from './github-store';
import { tryParseVaultEnvelope, vaultKdfFromEnvelope } from './vault-codec';
import { parseIndex } from './tier';

const PASSPHRASE = 'correct horse battery';
const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop';

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

/**
 * A fake GitHub API good enough for the whole commit sequence, recording every request so the test
 * can assert on what actually left the machine.
 */
function makeGitHubFetch(options: { private?: boolean; existingIndex?: string | null } = {}) {
  const calls: RecordedCall[] = [];
  const isPrivate = options.private ?? true;
  // A tiny in-memory repository, so a record can actually be read back after being committed.
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
      new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (method === 'GET' && /\/repos\/[^/]+\/[^/]+$/u.test(url)) {
      return json({
        full_name: 'zayeagle/omnipilot-synapse',
        private: isPrivate,
        default_branch: 'main',
        permissions: { push: true },
      });
    }
    if (method === 'GET' && url.includes('/contents/')) {
      const path = decodeURIComponent(url.split('/contents/')[1]?.split('?')[0] ?? '');
      if (path === 'index.json' && options.existingIndex && !files.has(path)) {
        return json({
          type: 'file',
          path,
          content: Buffer.from(options.existingIndex, 'utf8').toString('base64'),
          encoding: 'base64',
        });
      }
      const content = files.get(path);
      if (content === undefined) return json({ message: 'Not Found' }, 404);
      return json({
        type: 'file',
        path,
        sha: `sha-${path}`,
        content: Buffer.from(content, 'utf8').toString('base64'),
        encoding: 'base64',
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
      return json({ sha: 'commitsha', html_url: 'https://github.com/zayeagle/omnipilot-synapse/commit/commitsha' });
    }
    if (method === 'PATCH' && url.includes('/git/refs/heads/')) return json({ object: { sha: 'commitsha' } });
    return json({ message: `unhandled ${method} ${url}` }, 500);
  };

  return { fetchImpl, calls, files };
}

const FIXED_NOW = Date.parse('2026-07-09T00:00:00.000Z');

async function makeVaultSession(): Promise<{ session: KeySession; envelope: EncryptedEnvelope }> {
  const envelope = await createEnvelope(PASSPHRASE, '{}', { iterations: MIN_ITERATIONS });
  // The session clock must match the store's injected clock, otherwise the fixed "now" used by the
  // store looks like the past and the session is correctly treated as expired.
  const session = new KeySession({ store: new MemorySessionKeyStore(), now: () => FIXED_NOW });
  const key = await deriveKeyFromEnvelope(PASSPHRASE, envelope, { extractable: true });
  await session.adopt(key);
  return { session, envelope };
}

const SOURCE = newSourceItem({
  url: 'https://example.com/secret-article?utm_source=x',
  title: 'Secret article',
  body: 'CONFIDENTIAL-BODY-MARKER the actual captured text',
  capturedAt: new Date('2026-07-09T00:00:00.000Z'),
});

const BODY_MARKER = 'CONFIDENTIAL-BODY-MARKER';

describe('github store through the codec (F6 INT)', () => {
  it('TC-F2-I01 round-trips a record through the codec and the store unchanged', async () => {
    // The core contract across three modules: CKF → codec → store → read back → codec → CKF.
    // Transparent tier, so the assertion can also inspect the bytes that were written.
    const { fetchImpl, files } = makeGitHubFetch();
    const store = createGitHubStore({
      owner: 'zayeagle',
      repo: 'omnipilot-synapse',
      branch: 'main',
      apiBase: 'https://api.github.com',
      token: TOKEN,
      securityMode: 'transparent',
      fetchImpl,
      now: () => FIXED_NOW,
    });

    const committed = await store.commitRecord(SOURCE);
    const restored = await store.readRecord(committed.path);

    expect(restored).toEqual(SOURCE);
    // The stored bytes really do carry the CKF fields, not just the in-memory object.
    const written = files.get(committed.path) ?? '';
    expect(written).toContain(`id: "${SOURCE.id}"`);
    expect(written).toContain('kind: "source"');
    expect(written).toContain(SOURCE.body);

    // A second read after a fresh store instance resolves the same record (nothing is cached).
    const reopened = createGitHubStore({
      owner: 'zayeagle',
      repo: 'omnipilot-synapse',
      branch: 'main',
      apiBase: 'https://api.github.com',
      token: TOKEN,
      securityMode: 'transparent',
      fetchImpl,
      now: () => FIXED_NOW,
    });
    expect(await reopened.readRecord(committed.path)).toEqual(SOURCE);
  });

  it('TC-F6-I01 vault mode commits ciphertext plus a body-free index in one commit', async () => {
    const { fetchImpl, calls } = makeGitHubFetch();
    const { session, envelope } = await makeVaultSession();

    const store = createGitHubStore({
      owner: 'zayeagle',
      repo: 'omnipilot-synapse',
      branch: 'main',
      apiBase: 'https://api.github.com',
      token: TOKEN,
      securityMode: 'vault',
      session,
      kdf: vaultKdfFromEnvelope(envelope),
      fetchImpl,
      now: () => FIXED_NOW,
    });

    const result = await store.commitRecord(SOURCE);

    // One atomic commit: blobs 鈫?tree 鈫?commit 鈫?ref, and exactly one commit creation.
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/git/commits'))).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    expect(result.commit.sha).toBe('commitsha');
    expect(result.path.endsWith('.md.enc')).toBe(true);

    // Nothing that leaves the machine contains the captured body or the title in the clear.
    const serializedCalls = JSON.stringify(calls);
    expect(serializedCalls).not.toContain(BODY_MARKER);
    expect(serializedCalls).not.toContain('Secret article');
    // The token travels only in the Authorization header, never in a body.
    for (const call of calls) {
      expect(JSON.stringify(call.body ?? null)).not.toContain(TOKEN);
    }

    // The content blob is a well-formed envelope whose meta carries no content.
    // Blobs carry no path in the request body, so the two are told apart by their own shape.
    const contentBlob = calls.find(
      (call) =>
        call.method === 'POST' &&
        call.url.endsWith('/git/blobs') &&
        typeof (call.body as { content?: string }).content === 'string' &&
        (call.body as { content: string }).content.includes('"alg"'),
    );
    const envelopeText = (contentBlob?.body as { content: string }).content;
    const parsed = tryParseVaultEnvelope(envelopeText);
    expect(parsed).not.toBeNull();
    expect(parsed?.v).toBe(1);
    expect(Object.keys(parsed?.meta ?? {}).sort()).toEqual(['created_at', 'id', 'kind', 'updated_at']);
    expect(JSON.stringify(parsed?.meta)).not.toContain(BODY_MARKER);

    // The index blob enumerates the record with dedup keys and no content.
    const indexBlob = calls.find(
      (call) =>
        call.method === 'POST' &&
        call.url.endsWith('/git/blobs') &&
        typeof (call.body as { content?: string }).content === 'string' &&
        (call.body as { content: string }).content.includes('"schema"'),
    );
    const indexText = (indexBlob?.body as { content: string }).content;
    const index = parseIndex(indexText);
    expect(Object.keys(index.items)).toEqual([SOURCE.id]);
    expect(index.items[SOURCE.id]).toMatchObject({ kind: 'source', path: result.path });
    expect(indexText).not.toContain(BODY_MARKER);
    expect(indexText).not.toContain('Secret article');
    // The URL is represented only by its fingerprint, so the cleartext index does not reveal which
    // pages were captured — and the tracking parameter obviously cannot leak either.
    expect(indexText).not.toContain('utm_source');
    expect(indexText).not.toContain('secret-article');
    expect(index.items[SOURCE.id]?.url_key).toMatch(/^[0-9a-f]{16}$/u);

    // The path is opaque too: no title slug in the repository tree.
    expect(result.path).toBe(`inbox/2026/07/${SOURCE.id}.md.enc`);
    expect(calls.find((call) => call.method === 'POST' && call.url.endsWith('/git/commits'))?.body).toEqual({
      message: `source: [${SOURCE.id}]`,
      tree: 'treesha',
      parents: ['headsha'],
    });
  });

  it('TC-F6-I01 merges into an existing index inside the same commit', async () => {
    const existing = JSON.stringify({
      schema: 1,
      updated_at: '2026-07-01T00:00:00.000Z',
      items: {
        old00001: {
          id: 'old00001',
          kind: 'source',
          path: 'inbox/2026/01/old-old00001.md',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
      },
    });
    const { fetchImpl, calls } = makeGitHubFetch({ existingIndex: existing });
    const { session, envelope } = await makeVaultSession();

    const store = createGitHubStore({
      owner: 'zayeagle',
      repo: 'omnipilot-synapse',
      branch: 'main',
      apiBase: 'https://api.github.com',
      token: TOKEN,
      securityMode: 'vault',
      session,
      kdf: vaultKdfFromEnvelope(envelope),
      fetchImpl,
    });

    const result = await store.commitRecord(SOURCE);
    expect(Object.keys(result.index.items).sort()).toEqual(['old00001', SOURCE.id].sort());
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/git/commits'))).toHaveLength(1);
  });

  it('TC-F6-I01 refuses to write to a public repository and stops before the commit', async () => {
    const { fetchImpl, calls } = makeGitHubFetch({ private: false });
    const { session, envelope } = await makeVaultSession();

    const store = createGitHubStore({
      owner: 'zayeagle',
      repo: 'omnipilot-synapse',
      branch: 'main',
      apiBase: 'https://api.github.com',
      token: TOKEN,
      securityMode: 'vault',
      session,
      kdf: vaultKdfFromEnvelope(envelope),
      fetchImpl,
    });

    await expect(store.commitRecord(SOURCE)).rejects.toThrow(/public repository/u);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('TC-F6-I01 fails closed when the vault is locked, without contacting GitHub for a write', async () => {
    const { fetchImpl, calls } = makeGitHubFetch();
    const { envelope } = await makeVaultSession();
    const lockedSession = new KeySession({ store: new MemorySessionKeyStore() });

    const store = createGitHubStore({
      owner: 'zayeagle',
      repo: 'omnipilot-synapse',
      branch: 'main',
      apiBase: 'https://api.github.com',
      token: TOKEN,
      securityMode: 'vault',
      session: lockedSession,
      kdf: vaultKdfFromEnvelope(envelope),
      fetchImpl,
    });

    await expect(store.commitRecord(SOURCE)).rejects.toThrow(/locked/u);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });
});

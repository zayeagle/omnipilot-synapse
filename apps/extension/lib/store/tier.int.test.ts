import { describe, expect, it } from 'vitest';

import { newSourceItem, type CkfRecord, type SourceItem } from '../core/ckf';
import { indexPath, storeConfigPath } from '../core/paths';
import {
  MIN_ITERATIONS,
  createEnvelope,
  deriveKeyFromEnvelope,
  isEnvelope,
} from '../security/crypto-key';
import { KeySession, MemorySessionKeyStore } from '../security/key-session';
import { VAULT_EXTENSION, type ContentCodec } from './codec';
import {
  DEFAULT_STORE_BRANCH,
  DEFAULT_STORE_SYNC_POLICY,
  TierMigrationRequiredError,
  createStoreConfig,
  indexToFile,
  loadStoreConfig,
  mergeIndex,
  parseIndex,
  saveStoreConfig,
  selectCodec,
  serializeIndex,
  serializeStoreConfig,
  switchTier,
  type StoreSyncPolicy,
} from './tier';
import type { CommitResult, DirEntry, KnowledgeStore, RepoFile, StoreProbe } from './types';
import { readVaultMeta, vaultKdfFromEnvelope, type VaultKdf } from './vault-codec';

const PREFIX = 'knowledge';
const PASSPHRASE = 'correct horse battery';
const NOW = '2026-01-05T08:30:00.000Z';
const BODY = 'the quick brown fox jumps over the lazy dog — 机密正文';
const TITLE = 'Source 笔记';
const URL = 'https://example.com/posts/one?utm_source=newsletter&b=2#frag';

function makeItem(): SourceItem {
  return newSourceItem({
    id: 'src00001',
    url: URL,
    title: TITLE,
    body: BODY,
    tags: ['architecture'],
    capturedAt: new Date(NOW),
  });
}

/** In-memory `KnowledgeStore`: enough of the contract to run the real tier/commit path. */
class MemoryKnowledgeStore implements KnowledgeStore {
  readonly kind = 'github' as const;
  readonly commits: string[][] = [];
  private readonly files = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) this.files.set(path, content);
  }

  async probe(): Promise<StoreProbe> {
    return {
      kind: 'github',
      repoFullName: 'zayeagle/omnipilot-synapse',
      visibility: 'private',
      defaultBranch: 'main',
      canPush: true,
      canWrite: true,
      checkedAt: NOW,
    };
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const prefix = path === '' ? '' : `${path.replace(/\/+$/u, '')}/`;
    const out = new Map<string, DirEntry>();
    for (const candidate of this.files.keys()) {
      if (!candidate.startsWith(prefix)) continue;
      const rest = candidate.slice(prefix.length);
      const head = rest.split('/')[0];
      if (!head) continue;
      const full = `${prefix}${head}`;
      out.set(full, {
        name: head,
        path: full,
        sha: 'sha',
        type: rest.includes('/') ? 'dir' : 'file',
      });
    }
    return [...out.values()];
  }

  async commitFiles(files: RepoFile[], message: string): Promise<CommitResult> {
    for (const file of files) this.files.set(file.path, file.content);
    this.commits.push(files.map((file) => file.path));
    return {
      sha: `sha-${this.commits.length}`,
      htmlUrl: `https://example.test/commit/${this.commits.length}`,
      paths: files.map((file) => file.path),
    };
  }

  /** Fixture-only write that is not a commit, used to install a historical (0.1.0) layout. */
  seed(path: string, content: string): void {
    this.files.set(path, content);
  }

  /** Every committed path and its final content — the payload assertion surface for TC-F3-I01. */
  dump(): Record<string, string> {
    return Object.fromEntries([...this.files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}

interface VaultFixture {
  session: KeySession;
  kdf: VaultKdf;
}

async function vaultFixture(): Promise<VaultFixture> {
  const envelope = await createEnvelope(PASSPHRASE, JSON.stringify({ githubPat: '', providerKey: '' }), {
    iterations: MIN_ITERATIONS,
  });
  // The session and the codec share the default clock, so the unlock window is open right now.
  const session = new KeySession({
    store: new MemorySessionKeyStore(),
    ttlMs: 60 * 60 * 1000,
  });
  const key = await deriveKeyFromEnvelope(PASSPHRASE, envelope, { extractable: true });
  await session.adopt(key);
  return { session, kdf: vaultKdfFromEnvelope(envelope) };
}

/** The F6 commit shape: the content file and the updated index in one atomic commit. */
async function capture(
  store: MemoryKnowledgeStore,
  codec: ContentCodec,
  record: CkfRecord,
): Promise<{ path: string; indexText: string }> {
  const encoded = await codec.encodeRecord(record, PREFIX);
  const index = mergeIndex(parseIndex(await store.readFile(indexPath(PREFIX))), [encoded.index]);
  const indexText = indexToFile(index, PREFIX).content;
  await store.commitFiles(
    [
      { path: encoded.path, content: encoded.content },
      { path: indexPath(PREFIX), content: indexText },
    ],
    `capture: ${record.kind} [${record.id}]`,
  );
  return { path: encoded.path, indexText };
}

describe('vault-mode commit payload (F3 INT)', () => {
  it('TC-F3-I01 commits `.md.enc` files and an index.json that carries no body text', async () => {
    const store = new MemoryKnowledgeStore();
    const { session, kdf } = await vaultFixture();
    // This test is about vault behaviour, so it asks for vault explicitly rather than relying on the
    // default (which is now the readable tier for a brand-new store).
    const config = await loadStoreConfig({ store, prefix: PREFIX }, 'vault');
    expect(config.security_mode).toBe('vault');
    await saveStoreConfig({ store, prefix: PREFIX }, config);

    const codec = selectCodec(config.security_mode, session, undefined, { kdf, prefix: PREFIX });
    const item = makeItem();
    const committed = await capture(store, codec, item);

    expect(committed.path).toBe(`${PREFIX}/inbox/2026/01/src00001.md.enc`);
    const paths = store.paths();
    expect(paths).toHaveLength(3);
    expect(paths).toContain(committed.path);
    expect(paths).toContain(indexPath(PREFIX));
    expect(paths).toContain(storeConfigPath(PREFIX));

    // Every content file uses the encrypted extension.
    const contentPaths = paths.filter(
      (path) => !path.endsWith('index.json') && !path.endsWith('config.json'),
    );
    expect(contentPaths).toEqual([committed.path]);
    expect(contentPaths.every((path) => path.endsWith(VAULT_EXTENSION))).toBe(true);

    // index.json is valid JSON describing the committed file.
    const indexText = store.dump()[indexPath(PREFIX)] ?? '';
    const parsedIndex = JSON.parse(indexText) as {
      schema: number;
      items: Record<string, { kind: string; path: string; url_key?: string }>;
    };
    expect(parsedIndex.schema).toBe(1);
    expect(Object.keys(parsedIndex.items)).toEqual([item.id]);
    expect(parsedIndex.items[item.id]?.kind).toBe('source');
    expect(parsedIndex.items[item.id]?.path).toBe(committed.path);
    // The index keeps a *fingerprint* of the canonical URL, never the URL: dedup still works and the
    // cleartext index never lists which pages were read.
    expect(parsedIndex.items[item.id]?.url_key).toMatch(/^[0-9a-f]{16}$/);
    expect(parsedIndex.items[item.id]?.url_key).not.toContain('example.com');

    // Nothing plaintext survived the commit: no body, no title, no URL anywhere — including the
    // file path, which is id-only so the repository tree cannot leak the headline either.
    const everything = JSON.stringify(store.dump());
    expect(everything).not.toContain(BODY);
    expect(everything).not.toContain(TITLE);
    expect(everything).not.toContain(URL);
    expect(everything).not.toContain('utm_source');
    expect(everything).not.toContain('example.com');
    expect(everything).not.toContain('source-笔记');

    // The committed bytes are a well-formed envelope plus a minimal meta, and still decrypt.
    const fileText = store.dump()[committed.path] ?? '';
    expect(isEnvelope(JSON.parse(fileText) as unknown)).toBe(true);
    expect(readVaultMeta(fileText)).toEqual({
      kind: 'source',
      id: item.id,
      created_at: item.captured_at,
      updated_at: item.captured_at,
    });
    await expect(codec.decode(fileText)).resolves.toEqual(item);
  });

  it('TC-F3-I01 appends a second capture without losing the first index entry', async () => {
    const store = new MemoryKnowledgeStore();
    const { session, kdf } = await vaultFixture();
    const codec = selectCodec('vault', session, undefined, { kdf, prefix: PREFIX });
    const second = newSourceItem({
      id: 'src00002',
      url: 'https://example.com/two',
      title: 'Second 笔记',
      body: 'another body entirely',
      capturedAt: new Date('2026-01-07T00:00:00.000Z'),
    });

    await capture(store, codec, makeItem());
    await capture(store, codec, second);

    // Each capture is one atomic commit: one content file plus the index.
    expect(store.commits.map((paths) => paths.length)).toEqual([2, 2]);
    const parsed = parseIndex(store.dump()[indexPath(PREFIX)]);
    expect(Object.keys(parsed.items).sort()).toEqual(['src00001', 'src00002']);
    expect(parsed.items['src00001']?.path).toBe(`${PREFIX}/inbox/2026/01/src00001.md.enc`);
    expect(parsed.items['src00002']?.path).toBe(`${PREFIX}/inbox/2026/01/src00002.md.enc`);
    expect(JSON.stringify(store.dump())).not.toContain('another body entirely');
  });

  it('TC-F3-I01 writes plain Markdown in transparent mode through the same commit path', async () => {
    const store = new MemoryKnowledgeStore();
    const codec = selectCodec('transparent', null, undefined, { prefix: PREFIX });
    const item = makeItem();
    const committed = await capture(store, codec, item);

    expect(committed.path).toBe(`${PREFIX}/inbox/2026/01/source-笔记-src00001.md`);
    const fileText = store.dump()[committed.path] ?? '';
    // By definition this tier is readable — the contrast is what makes the vault assertions real.
    expect(fileText).toContain(BODY);
    expect(fileText).toContain(TITLE);
    expect(codec.matches(committed.path, fileText)).toBe(true);
    const parsed = parseIndex(store.dump()[indexPath(PREFIX)]);
    expect(parsed.items[item.id]?.path).toBe(committed.path);
  });

  it('TC-F3-I01 fails closed on a corrupt store config', async () => {
    const absent = new MemoryKnowledgeStore();
    expect((await loadStoreConfig({ store: absent, prefix: PREFIX }, 'transparent')).security_mode).toBe(
      'transparent',
    );

    const explicit = new MemoryKnowledgeStore({
      [storeConfigPath(PREFIX)]: serializeStoreConfig(createStoreConfig('transparent', NOW)),
    });
    expect((await loadStoreConfig({ store: explicit, prefix: PREFIX })).security_mode).toBe(
      'transparent',
    );

    // A file that exists but cannot be read must never downgrade the store to plaintext.
    for (const broken of ['not json at all', '"transparent"', '[]', '{"security_mode":"plaintext"}']) {
      const store = new MemoryKnowledgeStore({ [storeConfigPath(PREFIX)]: broken });
      expect((await loadStoreConfig({ store, prefix: PREFIX }, 'transparent')).security_mode).toBe(
        'vault',
      );
      // ... and the corrupt bytes are left untouched rather than overwritten.
      expect(store.commits).toEqual([]);
    }
  });

  it('TC-F3-I01 refuses a tier switch once the store holds items', async () => {
    const store = new MemoryKnowledgeStore();
    const { session, kdf } = await vaultFixture();
    await saveStoreConfig({ store, prefix: PREFIX }, createStoreConfig('vault', NOW));
    const codec = selectCodec('vault', session, undefined, { kdf, prefix: PREFIX });
    await capture(store, codec, makeItem());
    expect(store.commits.length).toBe(2);

    await expect(switchTier({ store, prefix: PREFIX, to: 'transparent' })).rejects.toThrow(
      TierMigrationRequiredError,
    );
    await expect(switchTier({ store, prefix: PREFIX, to: 'transparent' })).rejects.toMatchObject({
      name: 'TierMigrationRequiredError',
      code: 'validation',
      from: 'vault',
      to: 'transparent',
      itemCount: 1,
    });

    // The refused switch changed nothing and committed nothing.
    expect((await loadStoreConfig({ store, prefix: PREFIX })).security_mode).toBe('vault');
    expect(store.commits.length).toBe(2);
  });

  it('TC-F3-I01 allows a tier switch while the store is empty and is idempotent', async () => {
    const store = new MemoryKnowledgeStore();
    // A brand-new store defaults to the readable tier (the product wants a repository a human can
    // read); the switch itself must still work in both directions.
    expect((await loadStoreConfig({ store, prefix: PREFIX })).security_mode).toBe('transparent');

    const switched = await switchTier({
      store,
      prefix: PREFIX,
      to: 'vault',
      now: () => Date.parse(NOW),
    });
    expect(switched.security_mode).toBe('vault');
    expect(switched.created_at).toBe(NOW);
    expect((await loadStoreConfig({ store, prefix: PREFIX })).security_mode).toBe('vault');

    const commits = store.commits.length;
    const again = await switchTier({ store, prefix: PREFIX, to: 'vault' });
    expect(again.security_mode).toBe('vault');
    expect(store.commits.length).toBe(commits);

    // Switching back is still allowed: the store is empty.
    expect((await switchTier({ store, prefix: PREFIX, to: 'transparent' })).security_mode).toBe(
      'transparent',
    );
    expect((await loadStoreConfig({ store, prefix: PREFIX })).security_mode).toBe('transparent');
  });
});

/** The 0.1.0 config: no `branch`, no `sync_policy`, no `client_version`. */
const LEGACY_CONFIG = `${JSON.stringify(
  { schema_version: 1, security_mode: 'vault', created_at: NOW, updated_at: NOW },
  null,
  2,
)}\n`;

const LEGACY_INDEX = serializeIndex(
  mergeIndex(null, [
    {
      id: 'src00001',
      kind: 'source',
      path: `${PREFIX}/inbox/2026/01/src00001.md.enc`,
      created_at: NOW,
      updated_at: NOW,
    },
  ]),
);

describe('store config fields & 0.1.0 compatibility (F6 INT)', () => {
  it('TC-F6-I02 round-trips a custom branch through .omnipilot/config.json', async () => {
    const store = new MemoryKnowledgeStore({ [storeConfigPath(PREFIX)]: LEGACY_CONFIG });
    const loaded = await loadStoreConfig({ store, prefix: PREFIX });
    expect(loaded.branch).toBe(DEFAULT_STORE_BRANCH);

    const saved = await saveStoreConfig({ store, prefix: PREFIX }, { ...loaded, branch: 'release/2.x' });
    expect(saved.branch).toBe('release/2.x');
    const onDisk = JSON.parse(store.dump()[storeConfigPath(PREFIX)] ?? '{}') as { branch?: string };
    expect(onDisk.branch).toBe('release/2.x');

    // The branch lives in the file, so a fresh store instance reads the same value.
    const fresh = new MemoryKnowledgeStore(store.dump());
    expect((await loadStoreConfig({ store: fresh, prefix: PREFIX })).branch).toBe('release/2.x');
  });

  it('TC-F6-I03 writes the sync policy once and reads it on a fresh store instance', async () => {
    const store = new MemoryKnowledgeStore({ [storeConfigPath(PREFIX)]: LEGACY_CONFIG });
    const loaded = await loadStoreConfig({ store, prefix: PREFIX });
    const policy: StoreSyncPolicy = {
      interval_minutes: 5,
      on_startup: false,
      on_capture: true,
      pull_only: true,
    };

    const saved = await saveStoreConfig({ store, prefix: PREFIX }, { ...loaded, sync_policy: policy });
    expect(saved.sync_policy).toEqual(policy);
    expect(store.commits).toHaveLength(1);

    const fresh = new MemoryKnowledgeStore(store.dump());
    expect((await loadStoreConfig({ store: fresh, prefix: PREFIX })).sync_policy).toEqual(policy);
    // Reading the policy back is a read: the fresh instance committed nothing.
    expect(fresh.commits).toEqual([]);
  });

  it('TC-F6-U05 adds the new fields on the next write only', async () => {
    const store = new MemoryKnowledgeStore({ [storeConfigPath(PREFIX)]: LEGACY_CONFIG });
    const before = store.dump()[storeConfigPath(PREFIX)] ?? '';

    expect((await loadStoreConfig({ store, prefix: PREFIX })).security_mode).toBe('vault');
    // Reading a 0.1.0 repository never rewrites it: the new fields appear with the next write.
    expect(store.commits).toEqual([]);
    expect(store.dump()[storeConfigPath(PREFIX)]).toBe(before);

    await saveStoreConfig(
      { store, prefix: PREFIX, now: () => Date.parse(NOW), clientVersion: '0.2.0' },
      await loadStoreConfig({ store, prefix: PREFIX }),
      'config: upgrade layout',
    );
    expect(store.commits).toHaveLength(1);
    const rewritten = JSON.parse(store.dump()[storeConfigPath(PREFIX)] ?? '{}') as Record<string, unknown>;
    expect(Object.keys(rewritten)).toEqual([
      'schema_version',
      'security_mode',
      'branch',
      'sync_policy',
      'client_version',
      'created_at',
      'updated_at',
    ]);
    expect(rewritten['client_version']).toBe('0.2.0');
    expect(rewritten['created_at']).toBe(NOW);
    expect(rewritten['updated_at']).toBe(NOW);
  });

  it('TC-F6-I01 opens an existing vault repository without rewriting it', async () => {
    const store = new MemoryKnowledgeStore({
      [storeConfigPath(PREFIX)]: LEGACY_CONFIG,
      [indexPath(PREFIX)]: LEGACY_INDEX,
    });
    const loaded = await loadStoreConfig({ store, prefix: PREFIX });
    expect(loaded.security_mode).toBe('vault');
    expect(store.commits).toEqual([]);

    // Safe on doubt: a used repository keeps its tier and the refusal changes nothing.
    await expect(switchTier({ store, prefix: PREFIX, to: 'transparent' })).rejects.toThrow(
      TierMigrationRequiredError,
    );
    expect(store.commits).toEqual([]);
    expect(store.dump()[storeConfigPath(PREFIX)]).toBe(LEGACY_CONFIG);
  });

  it('TC-F6-I01 refuses to guess the tier of a repository with content but no config', async () => {
    const store = new MemoryKnowledgeStore({ [indexPath(PREFIX)]: LEGACY_INDEX });
    // The settings default says "transparent", but a repository that already holds content is not a
    // brand-new store, so the fallback fails closed and the user is asked.
    expect((await loadStoreConfig({ store, prefix: PREFIX }, 'transparent')).security_mode).toBe('vault');
    expect(store.commits).toEqual([]);
  });

  it('TC-REG-ext-store-01 keeps a 0.1.0 repository readable and unchanged', async () => {
    const store = new MemoryKnowledgeStore();
    const { session, kdf } = await vaultFixture();
    const codec = selectCodec('vault', session, undefined, { kdf, prefix: PREFIX });
    const record = makeItem();
    const committed = await capture(store, codec, record);
    store.seed(storeConfigPath(PREFIX), LEGACY_CONFIG);
    const before = store.dump();

    const config = await loadStoreConfig({ store, prefix: PREFIX });
    expect(config.security_mode).toBe('vault');
    expect(config.branch).toBe(DEFAULT_STORE_BRANCH);
    expect(config.sync_policy).toEqual(DEFAULT_STORE_SYNC_POLICY);
    // No `search/` tree, no new config fields: the 0.1.0 layout is read as it is on disk.
    expect(store.dump()).toEqual(before);
    expect(store.commits).toHaveLength(1);
    await expect(codec.decode(store.dump()[committed.path] ?? '')).resolves.toEqual(record);
  });
});

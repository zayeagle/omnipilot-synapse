import { describe, expect, it } from 'vitest';

import { newSourceItem } from '../core/ckf';
import { indexPath, storeConfigPath } from '../core/paths';
import { MIN_ITERATIONS, createEnvelope } from '../security/crypto-key';
import { KeySession, MemorySessionKeyStore, VaultLockedError } from '../security/key-session';
import { DEFAULT_SETTINGS, DEFAULT_SYNC_POLICY } from '../settings-store';
import { transparentCodec, type IndexItem } from './codec';
import {
  DEFAULT_SECURITY_MODE,
  DEFAULT_STORE_BRANCH,
  DEFAULT_STORE_SYNC_POLICY,
  INDEX_SCHEMA_VERSION,
  SAFE_FALLBACK_MODE,
  STORE_CONFIG_SCHEMA_VERSION,
  TierConfigError,
  UNKNOWN_CLIENT_VERSION,
  createStoreConfig,
  emptyIndex,
  findIndexItem,
  findIndexItemByKey,
  indexItemCount,
  indexToFile,
  isIndexEmpty,
  mergeIndex,
  parseIndex,
  parseStoreConfig,
  resolveTier,
  selectCodec,
  serializeIndex,
  serializeStoreConfig,
  type IndexFile,
} from './tier';
import { vaultKdfFromEnvelope } from './vault-codec';

const NOW = '2026-01-05T08:30:00.000Z';
const BODY = 'the quick brown fox jumps over the lazy dog — 机密正文';
const TITLE = 'Vault round trip 笔记';

function item(overrides: Partial<IndexItem> & { id: string }): IndexItem {
  return {
    kind: 'source',
    path: `inbox/2026/01/${overrides.id}.md`,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

describe('store tier config (F3 UNIT)', () => {
  it('TC-F3-U02 creates, round-trips and serializes `.omnipilot/config.json`', () => {
    const created = createStoreConfig('transparent', NOW);
    expect(created).toEqual({
      schema_version: STORE_CONFIG_SCHEMA_VERSION,
      security_mode: 'transparent',
      branch: DEFAULT_STORE_BRANCH,
      sync_policy: DEFAULT_STORE_SYNC_POLICY,
      client_version: UNKNOWN_CLIENT_VERSION,
      created_at: NOW,
      updated_at: NOW,
    });

    const text = serializeStoreConfig(created);
    expect(text.endsWith('\n')).toBe(true);
    expect(parseStoreConfig(JSON.parse(text) as unknown, NOW)).toEqual(created);

    const vault = parseStoreConfig({ security_mode: 'vault' }, NOW);
    expect(vault.security_mode).toBe('vault');
    expect(vault.created_at).toBe(NOW);
  });

  it('TC-F3-U02 falls back to the chosen tier when absent and fails closed when corrupt', () => {
    expect(parseStoreConfig(null, NOW, 'transparent').security_mode).toBe('transparent');
    expect(parseStoreConfig(undefined, NOW).security_mode).toBe(DEFAULT_SECURITY_MODE);
    // A brand-new store is readable Markdown by default (the product asks for a repository a human
    // can read); unknown state still fails closed to the encrypted tier.
    expect(DEFAULT_SECURITY_MODE).toBe('transparent');
    expect(SAFE_FALLBACK_MODE).toBe('vault');

    // A corrupt file must never silently downgrade the store to plaintext.
    const corrupt = parseStoreConfig({ security_mode: 'plaintext-please' }, NOW, 'transparent');
    expect(corrupt.security_mode).toBe('vault');

    // Unreadable timestamps are replaced rather than propagated.
    const stale = parseStoreConfig({ security_mode: 'vault', created_at: 'yesterday' }, NOW);
    expect(stale.created_at).toBe(NOW);
    expect(stale.updated_at).toBe(NOW);

    const kept = parseStoreConfig(
      { security_mode: 'vault', created_at: NOW, updated_at: '2026-02-01T00:00:00.000Z' },
      NOW,
    );
    expect(kept.created_at).toBe(NOW);
    expect(kept.updated_at).toBe('2026-02-01T00:00:00.000Z');
  });

  it('TC-F3-U02 resolves the config and index paths from the store prefix', () => {
    expect(storeConfigPath('knowledge')).toBe('knowledge/.omnipilot/config.json');
    expect(storeConfigPath()).toBe('.omnipilot/config.json');
    expect(indexPath('knowledge')).toBe('knowledge/index.json');
    expect(indexToFile(emptyIndex(), 'knowledge')).toEqual({
      path: 'knowledge/index.json',
      content: serializeIndex(emptyIndex()),
    });
  });
});

describe('index.json helpers (F3 UNIT)', () => {
  it('TC-F3-U02 treats a missing, empty or corrupt index as empty', () => {
    for (const text of [null, undefined, '', '   ', 'not json', '[]', '{"items":[]}', '42']) {
      const parsed = parseIndex(text);
      expect(parsed.schema).toBe(INDEX_SCHEMA_VERSION);
      expect(parsed.items).toEqual({});
      expect(isIndexEmpty(parsed)).toBe(true);
      expect(indexItemCount(parsed)).toBe(0);
    }
  });

  it('TC-F3-U02 re-injects the map key as the id and drops malformed entries', () => {
    const parsed = parseIndex(
      JSON.stringify({
        schema: 99,
        items: {
          good: { id: 'a-different-id', kind: 'source', path: 'inbox/a.md', created_at: NOW, updated_at: NOW, url_key: 'https://a', content_key: 'abc' },
          'no-kind': { id: 'x', path: 'p', created_at: NOW, updated_at: NOW },
          'bad-kind': { id: 'x', kind: 'mystery', path: 'p', created_at: NOW, updated_at: NOW },
          'no-path': { id: 'x', kind: 'source', path: '', created_at: NOW, updated_at: NOW },
          'bad-date': { id: 'x', kind: 'source', path: 'p', created_at: 'soon', updated_at: NOW },
          'not-an-object': 'nope',
        },
      }),
    );

    expect(Object.keys(parsed.items)).toEqual(['good']);
    expect(parsed.items['good']?.id).toBe('good');
    expect(parsed.items['good']?.url_key).toBe('https://a');
    expect(parsed.items['good']?.content_key).toBe('abc');
    // Unknown keys never survive a round trip.
    expect(parsed.items['good']).not.toHaveProperty('schema');
  });

  it('TC-F3-U02 serializes deterministically with sorted ids', () => {
    const index: IndexFile = {
      schema: INDEX_SCHEMA_VERSION,
      items: { beta: item({ id: 'beta' }), alpha: item({ id: 'alpha' }) },
    };
    const text = serializeIndex(index);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"beta"'));
    expect(serializeIndex(parseIndex(text))).toBe(text);
    expect((JSON.parse(text) as { schema: number }).schema).toBe(INDEX_SCHEMA_VERSION);
  });

  it('TC-F3-U02 merges with last-write-wins and never mutates its inputs', () => {
    const base = mergeIndex(null, [item({ id: 'a', path: 'old.md' })]);
    const snapshot = JSON.parse(JSON.stringify(base)) as IndexFile;

    const merged = mergeIndex(base, [
      item({ id: 'b', path: 'new.md' }),
      item({ id: 'a', path: 'newer.md', updated_at: '2026-02-01T00:00:00.000Z' }),
    ]);

    expect(base).toEqual(snapshot);
    expect(Object.keys(merged.items).sort()).toEqual(['a', 'b']);
    expect(findIndexItem(merged, 'a')?.path).toBe('newer.md');
    expect(findIndexItem(merged, 'a')?.updated_at).toBe('2026-02-01T00:00:00.000Z');
    expect(findIndexItem(merged, 'missing')).toBeNull();
    expect(indexItemCount(merged)).toBe(2);
    expect(isIndexEmpty(merged)).toBe(false);
  });

  it('TC-F3-U02 probes the dedup keys without reading any content file', () => {
    const index = mergeIndex(null, [
      item({ id: 'a', url_key: 'https://example.com/one', content_key: 'abc' }),
      item({ id: 'b', url_key: 'https://example.com/two', content_key: 'def' }),
    ]);

    expect(findIndexItemByKey(index, 'url_key', 'https://example.com/two')?.id).toBe('b');
    expect(findIndexItemByKey(index, 'content_key', 'def')?.id).toBe('b');
    expect(findIndexItemByKey(index, 'url_key', 'https://example.com/three')).toBeNull();
    expect(findIndexItemByKey(index, 'url_key', '')).toBeNull();
  });

  it('TC-F3-U02 carries nothing but identifiers, timestamps and dedup keys', () => {
    const record = newSourceItem({
      id: 'src00001',
      url: 'https://example.com/posts/one?utm_source=newsletter',
      title: TITLE,
      body: BODY,
      capturedAt: new Date(NOW),
    });
    const entry = transparentCodec.indexEntry(record, 'inbox/2026/01/note.md');
    const text = serializeIndex(mergeIndex(null, [entry]));

    expect(Object.keys(entry).sort()).toEqual([
      'content_key',
      'created_at',
      'id',
      'kind',
      'path',
      'updated_at',
      'url_key',
    ]);
    expect(text).not.toContain(BODY);
    expect(text).not.toContain(TITLE);
    expect(text).not.toContain('utm_source');
    expect(text).not.toContain(record.url);
  });
});

describe('codec selection (F3 UNIT)', () => {
  it('TC-F3-U06 returns the transparent codec without needing a session', () => {
    const codec = selectCodec('transparent', null);
    expect(codec.mode).toBe('transparent');
    expect(codec.extension).toBe('.md');
    expect(transparentCodec.extension).toBe(codec.extension);
  });

  it('TC-F3-U06 refuses vault mode when the store has no KDF parameters', () => {
    const locked = new KeySession({ store: new MemorySessionKeyStore() });
    expect(() => selectCodec('vault', locked)).toThrow(TierConfigError);
    try {
      selectCodec('vault', null);
      throw new Error('selectCodec should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TierConfigError);
      expect((error as TierConfigError).code).toBe('notConfigured');
    }
  });

  it('TC-F3-U06 returns a vault codec that fails closed while the session is locked', async () => {
    const envelope = await createEnvelope('correct horse battery', JSON.stringify({}), {
      iterations: MIN_ITERATIONS,
    });
    const session = new KeySession({ store: new MemorySessionKeyStore() });
    const codec = selectCodec('vault', session, undefined, {
      kdf: vaultKdfFromEnvelope(envelope),
      prefix: 'knowledge',
      now: () => Date.parse(NOW),
    });
    const record = newSourceItem({
      id: 'src00001',
      url: 'https://example.com/posts/one',
      title: TITLE,
      body: BODY,
      capturedAt: new Date(NOW),
    });

    expect(codec.mode).toBe('vault');
    expect(codec.extension).toBe('.md.enc');
    await expect(codec.encodeRecord(record)).rejects.toThrow(VaultLockedError);
    expect(codec.indexEntry(record, 'knowledge/inbox/2026/01/x.md.enc').path).toBe(
      'knowledge/inbox/2026/01/x.md.enc',
    );
  });
});

describe('tier resolution (F6 UNIT)', () => {
  it('TC-F6-U02 defaults a brand-new store and lets the recorded mode win', () => {
    const absent = resolveTier({ configText: null, now: NOW });
    expect(absent).toEqual({
      mode: DEFAULT_SECURITY_MODE,
      source: 'default',
      requiresUserDecision: false,
      config: createStoreConfig(DEFAULT_SECURITY_MODE, NOW),
    });

    for (const configText of [undefined, '', '   ']) {
      expect(resolveTier({ configText, now: NOW }).mode).toBe(DEFAULT_SECURITY_MODE);
    }
    // The settings UI's choice is honoured for a brand-new store — and only for a brand-new one.
    expect(resolveTier({ configText: null, fallbackMode: 'vault', now: NOW }).mode).toBe('vault');

    const recorded = resolveTier({
      configText: serializeStoreConfig(createStoreConfig('vault', NOW)),
      fallbackMode: 'transparent',
      now: NOW,
    });
    expect(recorded.mode).toBe('vault');
    expect(recorded.source).toBe('config');
    expect(recorded.requiresUserDecision).toBe(false);
    expect(recorded.config.security_mode).toBe('vault');
  });

  it('TC-F6-U02 never switches a repository that has content but no config', () => {
    const resolution = resolveTier({
      configText: null,
      hasContent: true,
      fallbackMode: 'transparent',
      now: NOW,
    });
    expect(resolution.mode).toBe(SAFE_FALLBACK_MODE);
    expect(resolution.source).toBe('unknown');
    expect(resolution.requiresUserDecision).toBe(true);
    // Absent config on an *empty* store is still the new-store default, not an unknown state.
    expect(resolveTier({ configText: null, hasContent: false, now: NOW }).source).toBe('default');
  });

  it('TC-F6-U03 preserves an existing vault config', () => {
    const legacy = { schema_version: 1, security_mode: 'vault', created_at: NOW, updated_at: NOW };
    const resolution = resolveTier({
      configText: JSON.stringify(legacy),
      fallbackMode: 'transparent',
      now: NOW,
    });
    expect(resolution.mode).toBe('vault');
    expect(resolution.source).toBe('config');
    expect(resolution.requiresUserDecision).toBe(false);
    // The tier is preserved; the not-yet-written fields exist in memory with their defaults only.
    expect(resolution.config.branch).toBe(DEFAULT_STORE_BRANCH);
  });

  it('TC-F6-U04 treats an unreadable config as unknown and asks instead of guessing', () => {
    const cases = [
      '{',
      'not json at all',
      '"transparent"',
      '[]',
      '42',
      'null',
      '{}',
      '{"security_mode":"plaintext-please"}',
    ];
    for (const configText of cases) {
      const resolution = resolveTier({ configText, fallbackMode: 'transparent', now: NOW });
      expect(resolution.mode).toBe(SAFE_FALLBACK_MODE);
      expect(resolution.source).toBe('unknown');
      expect(resolution.requiresUserDecision).toBe(true);
      expect(resolution.config.security_mode).toBe(SAFE_FALLBACK_MODE);
    }
  });
});

describe('store config fields (F6 UNIT)', () => {
  it('TC-F6-U05 reads a 0.1.0 config with defaults and never throws', () => {
    const legacy = { schema_version: 1, security_mode: 'vault', created_at: NOW, updated_at: NOW };
    expect(parseStoreConfig(legacy, NOW)).toEqual({
      schema_version: STORE_CONFIG_SCHEMA_VERSION,
      security_mode: 'vault',
      branch: DEFAULT_STORE_BRANCH,
      sync_policy: DEFAULT_STORE_SYNC_POLICY,
      client_version: UNKNOWN_CLIENT_VERSION,
      created_at: NOW,
      updated_at: NOW,
    });
    // Additive change: the file stays version 1 so a 0.1.0 reader still accepts it.
    expect(STORE_CONFIG_SCHEMA_VERSION).toBe(1);
  });

  it('TC-F6-U05 round-trips the extended config byte for byte', () => {
    const config = createStoreConfig('transparent', NOW, {
      branch: 'release/2.x',
      sync_policy: { interval_minutes: 5, pull_only: true },
      client_version: '0.2.0',
    });
    expect(config.sync_policy).toEqual({
      ...DEFAULT_STORE_SYNC_POLICY,
      interval_minutes: 5,
      pull_only: true,
    });

    const text = serializeStoreConfig(config);
    expect(text.indexOf('"schema_version"')).toBeLessThan(text.indexOf('"security_mode"'));
    expect(text.indexOf('"security_mode"')).toBeLessThan(text.indexOf('"branch"'));
    expect(text.indexOf('"branch"')).toBeLessThan(text.indexOf('"sync_policy"'));
    expect(text.indexOf('"sync_policy"')).toBeLessThan(text.indexOf('"client_version"'));
    expect(serializeStoreConfig(parseStoreConfig(JSON.parse(text) as unknown, NOW))).toBe(text);
  });

  it('TC-F6-U05 tolerates junk in the new fields instead of losing the tier', () => {
    const parsed = parseStoreConfig(
      {
        security_mode: 'vault',
        branch: '   ',
        sync_policy: { interval_minutes: -5, on_startup: 'yes', extra: true },
        client_version: 7,
      },
      NOW,
      'transparent',
    );
    expect(parsed.security_mode).toBe('vault');
    expect(parsed.branch).toBe(DEFAULT_STORE_BRANCH);
    expect(parsed.sync_policy).toEqual(DEFAULT_STORE_SYNC_POLICY);
    expect(parsed.client_version).toBe(UNKNOWN_CLIENT_VERSION);

    // A partial policy keeps the fields it does carry and defaults the rest.
    const partial = parseStoreConfig(
      { security_mode: 'vault', branch: 'trunk', sync_policy: { interval_minutes: 15 } },
      NOW,
    );
    expect(partial.branch).toBe('trunk');
    expect(partial.sync_policy).toEqual({ ...DEFAULT_STORE_SYNC_POLICY, interval_minutes: 15 });

    // Out-of-range intervals clamp; unknown keys never survive a write.
    const clamped = parseStoreConfig(
      { security_mode: 'vault', sync_policy: { interval_minutes: 99999 } },
      NOW,
    );
    expect(clamped.sync_policy.interval_minutes).toBe(24 * 60);
    expect(
      serializeStoreConfig(parseStoreConfig({ security_mode: 'vault', sync_policy: { extra: 1 } }, NOW)),
    ).not.toContain('extra');
  });

  it('TC-F6-U05 keeps the store defaults aligned with the settings defaults', () => {
    expect(DEFAULT_STORE_BRANCH).toBe(DEFAULT_SETTINGS.github.branch);
    expect(DEFAULT_STORE_SYNC_POLICY).toEqual({
      interval_minutes: DEFAULT_SYNC_POLICY.intervalMinutes,
      on_startup: DEFAULT_SYNC_POLICY.onStartup,
      on_capture: DEFAULT_SYNC_POLICY.onCapture,
      pull_only: DEFAULT_SYNC_POLICY.pullOnly,
    });
  });
});

import { describe, expect, it } from 'vitest';
import type { CkfRecord, SourceItem } from '../core/ckf';
import {
  EMPTY_SYNC_STATE,
  SyncCache,
  createMemoryBackend,
  normalizeCachedRecord,
  normalizeSyncState,
} from './cache';

/**
 * TC-F3-U01…U03, U07 — the cache contract.
 *
 * The cache is disposable by design (everything rebuilds from the repository), so what matters is not
 * durability but **what a caller may believe**: a foreign entry is dropped rather than half-trusted, a
 * dirty path survives until it is explicitly cleaned, and a pulled record remembers the *remote's*
 * version so the next sync can recognise it as unchanged (SC-F5-01).
 */

const V1 = '2026-01-01T10:00:00.000Z';

function source(id: string, version = V1): SourceItem {
  return {
    id,
    kind: 'source',
    channel: 'extension',
    url: 'https://example.test/a',
    title: id,
    body: 'body',
    content_hash: 'h',
    captured_at: version,
    tags: [],
  };
}

describe('SyncCache (F3 UNIT)', () => {
  it('TC-F3-U01 keeps the remote version alongside the decoded record', async () => {
    const cache = new SyncCache(createMemoryBackend());
    await cache.put(source('a'), {
      path: 'inbox/a.md',
      sha: 'blob-1',
      contentKey: 'ck:1',
      remoteUpdatedAt: V1,
    });

    const entry = await cache.get('inbox/a.md');
    expect(entry).toMatchObject({
      path: 'inbox/a.md',
      sha: 'blob-1',
      id: 'a',
      kind: 'source',
      contentKey: 'ck:1',
      remoteUpdatedAt: V1,
    });
    expect((entry?.record as SourceItem).title).toBe('a');
  });

  it('TC-F3-U02 a dirty path survives until it is cleaned, and cleaning is by path', async () => {
    const cache = new SyncCache(createMemoryBackend());
    await cache.put(source('a'), { path: 'inbox/a.md', sha: '', markDirty: true });
    await cache.put(source('b'), { path: 'inbox/b.md', sha: '', markDirty: true });

    expect(await cache.dirty()).toEqual(['inbox/a.md', 'inbox/b.md']);
    await cache.clean(['inbox/a.md']);
    expect(await cache.dirty()).toEqual(['inbox/b.md']);
  });

  it('TC-F3-U03 state is merged, not replaced, and validates foreign values', async () => {
    const cache = new SyncCache(createMemoryBackend());
    expect(await cache.state()).toEqual(EMPTY_SYNC_STATE);

    await cache.updateState({ head: 'sha-1', lastOutcome: 'pulled' });
    await cache.updateState({ conflicts: ['inbox/c.md'] });

    expect(await cache.state()).toMatchObject({
      head: 'sha-1',
      lastOutcome: 'pulled',
      conflicts: ['inbox/c.md'],
    });
  });

  it('TC-F3-U07 forgetting a path drops the record but never the sync state', async () => {
    const cache = new SyncCache(createMemoryBackend());
    await cache.put(source('a'), { path: 'inbox/a.md', sha: '', markDirty: true });
    await cache.updateState({ head: 'sha-9' });

    await cache.forget('inbox/a.md');

    expect(await cache.get('inbox/a.md')).toBeNull();
    expect(await cache.all()).toEqual([]);
    expect((await cache.state()).head).toBe('sha-9');
  });

  it('TC-F3-U07 a foreign or corrupt entry is dropped, not half-trusted', () => {
    expect(normalizeCachedRecord(null)).toBeNull();
    expect(normalizeCachedRecord({ path: 'a', sha: 's' })).toBeNull();
    expect(normalizeCachedRecord({ path: 'a', sha: 's', record: { kind: 'source' } })).toBeNull();
    expect(normalizeCachedRecord({ path: '', sha: 's', record: { kind: 'source', id: 'a' } })).toBeNull();

    const kept = normalizeCachedRecord({
      path: 'inbox/a.md',
      sha: 'blob',
      record: { kind: 'source', id: 'a' },
    });
    expect(kept).toMatchObject({ path: 'inbox/a.md', id: 'a', kind: 'source' });
    // Missing timestamps fall back to the epoch rather than to "now": a fabricated time would make a
    // pulled record look freshly changed and trigger an endless re-pull.
    expect(kept?.updatedAt).toBe(new Date(0).toISOString());
  });

  it('TC-F3-U07 an unknown outcome is not echoed back to the UI', () => {
    expect(normalizeSyncState({ lastOutcome: 'exploded', head: 7 }).lastOutcome).toBe('never');
    expect(normalizeSyncState({ lastOutcome: 'merged' }).lastOutcome).toBe('merged');
    expect(normalizeSyncState('nonsense')).toEqual(EMPTY_SYNC_STATE);
  });

  it('TC-F3-U07 clear() empties records and state together', async () => {
    const cache = new SyncCache(createMemoryBackend());
    await cache.put(source('a'), { path: 'inbox/a.md', sha: '', markDirty: true });
    await cache.updateState({ head: 'sha-1' });

    await cache.clear();

    expect(await cache.all()).toEqual([]);
    expect(await cache.state()).toEqual(EMPTY_SYNC_STATE);
  });

  it('TC-F3-U07 a record read back out of the backend still decodes as a CKF record', async () => {
    const backend = createMemoryBackend();
    const cache = new SyncCache(backend);
    const record: CkfRecord = source('a');
    await cache.put(record, { path: 'inbox/a.md', sha: '' });
    const fromBackend = await backend.listRecords();
    expect(fromBackend).toHaveLength(1);
    expect(normalizeCachedRecord(fromBackend[0])?.record).toEqual(record);
  });
});

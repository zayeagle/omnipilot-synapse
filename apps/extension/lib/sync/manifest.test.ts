import { describe, expect, it } from 'vitest';

import {
  describeManifestDiff,
  diffRemoteManifest,
  localChanges,
  manifestMatches,
  sameVersion,
  type CacheEntry,
  type ManifestEntry,
} from './manifest';
import { planMerge } from './reconcile';

const AT = Date.UTC(2026, 6, 9, 14, 30, 0);

function manifest(path: string, overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    path,
    id: path.split('/').pop()?.replace('.md', '') ?? 'x',
    kind: 'source',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function cached(path: string, overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    path,
    id: path.split('/').pop()?.replace('.md', '') ?? 'x',
    kind: 'source',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('remote manifest diff (F3 UNIT)', () => {
  it('TC-F3-U13 reports nothing when the manifest and the cache agree', () => {
    const entries = [manifest('inbox/a.md'), manifest('inbox/b.md')];
    const diff = diffRemoteManifest(entries, [
      cached('inbox/a.md'),
      cached('inbox/b.md'),
    ]);
    expect(diff.remote).toEqual([]);
    expect(diff.deletedRemotely).toEqual([]);
    expect(diff.unchanged).toEqual(['inbox/a.md', 'inbox/b.md']);
    expect(manifestMatches(diff)).toBe(true);
    expect(describeManifestDiff(diff)).toBe('remote=0 deleted=0 unchanged=2');
  });

  it('TC-F3-U13 treats a path the cache has never seen as added', () => {
    const diff = diffRemoteManifest([manifest('inbox/new.md')], []);
    expect(diff.remote).toEqual([{ path: 'inbox/new.md', kind: 'added' }]);
    expect(diff.unchanged).toEqual([]);
  });

  it('TC-F3-U13 treats a newer timestamp as modified', () => {
    const diff = diffRemoteManifest(
      [manifest('inbox/a.md', { updated_at: '2026-07-08T00:00:00.000Z' })],
      [cached('inbox/a.md', { updatedAt: '2026-07-01T00:00:00.000Z' })],
    );
    expect(diff.remote).toEqual([{ path: 'inbox/a.md', kind: 'modified' }]);
  });

  it('TC-F3-U13 treats a path missing from the manifest as deleted remotely', () => {
    const diff = diffRemoteManifest(
      [manifest('inbox/kept.md')],
      [cached('inbox/kept.md'), cached('inbox/gone.md')],
    );
    expect(diff.deletedRemotely).toEqual(['inbox/gone.md']);
    expect(diff.remote).toEqual([]);
  });

  it('TC-F3-U14 prefers the content key over the timestamp', () => {
    // Same bytes, rewritten metadata: this must NOT be reported as a change, otherwise every
    // metadata-only commit would refetch the whole repository.
    const remote = manifest('inbox/a.md', {
      updated_at: '2026-07-09T00:00:00.000Z',
      content_key: 'deadbeefdeadbeef',
    });
    const local = cached('inbox/a.md', { updatedAt: '2026-07-01T00:00:00.000Z', contentKey: 'deadbeefdeadbeef' });
    expect(sameVersion(remote, local)).toBe(true);
    expect(diffRemoteManifest([remote], [local]).remote).toEqual([]);

    // Same timestamp but different bytes: a real change, and the key catches it.
    const changed = manifest('inbox/a.md', {
      updated_at: '2026-07-01T00:00:00.000Z',
      content_key: '0000000000000000',
    });
    expect(diffRemoteManifest([changed], [local]).remote).toEqual([
      { path: 'inbox/a.md', kind: 'modified', key: '0000000000000000' },
    ]);
  });

  it('TC-F3-U14 falls back to the timestamp when a key is missing on either side', () => {
    const remote = manifest('inbox/a.md', { content_key: 'aaaaaaaaaaaaaaaa' });
    const local = cached('inbox/a.md');
    expect(sameVersion(remote, local)).toBe(true); // timestamps match, no key to compare

    const moved = manifest('inbox/a.md', { updated_at: '2026-07-05T00:00:00.000Z' });
    expect(sameVersion(moved, local)).toBe(false);
  });

  it('TC-F3-U13 sorts its output so two runs produce identical plans', () => {
    const diff = diffRemoteManifest(
      [manifest('inbox/z.md'), manifest('inbox/a.md'), manifest('inbox/m.md')],
      [],
    );
    expect(diff.remote.map((change) => change.path)).toEqual([
      'inbox/a.md',
      'inbox/m.md',
      'inbox/z.md',
    ]);
  });

  it('TC-F3-U13 turns the dirty set into local changes with add/modify distinguished', () => {
    const changes = localChanges(
      ['inbox/new.md', 'inbox/known.md', 'inbox/a-new.md'],
      [cached('inbox/known.md'), cached('inbox/a-new.md')],
    );
    expect(changes).toEqual([
      { path: 'inbox/a-new.md', kind: 'modified' },
      { path: 'inbox/known.md', kind: 'modified' },
      { path: 'inbox/new.md', kind: 'added' },
    ]);
  });
});

describe('manifest diff feeding the merge plan (F3 UNIT)', () => {
  it('TC-F3-U13 a remote-only change produces a pull and no push', () => {
    const cache = [cached('inbox/old.md')];
    const diff = diffRemoteManifest(
      [manifest('inbox/old.md'), manifest('inbox/fresh.md', { updated_at: '2026-07-08T00:00:00.000Z' })],
      cache,
    );
    const plan = planMerge({
      local: localChanges([], cache),
      remote: diff.remote,
      now: () => AT,
    });
    expect(plan.pull).toEqual(['inbox/fresh.md']);
    expect(plan.push).toEqual([]);
  });

  it('TC-F3-U13 a locally edited note the remote also changed becomes a conflict copy', () => {
    const cache = [cached('inbox/shared.md')];
    const diff = diffRemoteManifest(
      [manifest('inbox/shared.md', { updated_at: '2026-07-08T00:00:00.000Z' })],
      cache,
    );
    const plan = planMerge({
      local: localChanges(['inbox/shared.md'], cache),
      remote: diff.remote,
      now: () => AT,
    });
    expect(plan.pull).toEqual(['inbox/shared.md']);
    expect(plan.push).toEqual(['inbox/shared.conflict-202607091430.md']);
    expect(plan.conflicts).toHaveLength(1);
  });

  it('TC-F3-U13 a remote deletion of an untouched note drops it locally', () => {
    const cache = [cached('inbox/gone.md')];
    const diff = diffRemoteManifest([], cache);
    const plan = planMerge({
      local: localChanges([], cache),
      remote: [{ path: 'inbox/gone.md', kind: 'deleted' }],
      now: () => AT,
    });
    expect(plan.removeLocal).toEqual(['inbox/gone.md']);
    expect(diff.deletedRemotely).toEqual(['inbox/gone.md']);
  });
});

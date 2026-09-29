import { describe, expect, it } from 'vitest';
import type { CkfRecord, SourceItem } from '../core/ckf';
import { indexPath } from '../core/paths';
import { isTombstone } from '../core/tombstone';
import { transparentCodec } from '../store/codec';
import type { IndexFile } from '../store/tier';
import type { RepoFile } from '../store/types';
import { dropIndexItemsAtPath, planConflictResolution } from './conflict';

/**
 * TC-P4-U01/U02, TC-P4-I01 — the three ways out of a conflict.
 *
 * What is asserted is what the user is left with: which version owns the original path, where the other one is
 * still readable, that the sibling stops looking like a note, and that `keep-both` does not read anything at all
 * (which is what makes it usable with a locked vault).
 */

const AT = '2026-09-29T12:00:00.000Z';
const MAIN = 'inbox/2026/09/note-abc.md';
const SIBLING = 'inbox/2026/09/note-abc.conflict-202609291200.md';

function source(body: string): SourceItem {
  return {
    id: 'abc',
    kind: 'source',
    channel: 'extension',
    url: 'https://example.test/a',
    title: 'Note',
    body,
    content_hash: 'h',
    captured_at: AT,
    tags: [],
  };
}

function indexWith(): IndexFile {
  return {
    schema: 1,
    items: {
      abc: { id: 'abc', kind: 'source', path: MAIN, created_at: AT, updated_at: AT, content_key: 'theirs' },
      'abc-conflict-202609291200': {
        id: 'abc-conflict-202609291200',
        kind: 'source',
        path: SIBLING,
        created_at: AT,
        updated_at: AT,
        content_key: 'mine',
      },
    },
  };
}

async function fixtures() {
  return {
    mainText: await transparentCodec.encode(source('theirs body')),
    siblingText: await transparentCodec.encode(source('mine body')),
  };
}

function deps(mainText: string | null, siblingText: string | null) {
  const shard: RepoFile = { path: 'search/no.json', content: '{}' };
  const seen: string[] = [];
  return {
    seen,
    deps: {
      codec: transparentCodec,
      index: indexWith(),
      prefix: null,
      now: () => Date.parse(AT),
      read: async (path: string) => {
        seen.push(path);
        return path === MAIN ? mainText : siblingText;
      },
      shards: {
        change: async (survivor: CkfRecord, loser: CkfRecord) => {
          seen.push('shards:' + survivor.id + '/' + loser.id);
          return [shard];
        },
      },
    },
  };
}

describe('conflict resolution (F4 UNIT)', () => {
  it('TC-P4-U01 keep-both reads nothing and commits nothing — the vault-safe way out', async () => {
    const { deps: d, seen } = deps(null, null);
    const plan = await planConflictResolution({ path: MAIN, conflictPath: SIBLING, action: 'keep-both' }, d);

    expect(plan.commit).toBe(false);
    expect(plan.files).toEqual([]);
    expect(seen).toEqual([]);
    expect(plan.path).toBe(MAIN);
  });

  it('TC-P4-U02 keep-mine puts our version back at the original path and archives theirs', async () => {
    const { mainText, siblingText } = await fixtures();
    const plan = await planConflictResolution({ path: MAIN, conflictPath: SIBLING, action: 'keep-mine' }, deps(mainText, siblingText).deps);

    const main = plan.files.find((file) => file.path === MAIN)?.content ?? '';
    expect(main).toContain('mine body');
    expect(plan.archivedPath).toBe('archive/conflicts/' + MAIN);
    // The loser is copied byte-for-byte, so archiving cannot corrupt it.
    expect(plan.files.find((file) => file.path === plan.archivedPath)?.content).toBe(mainText);
    expect(isTombstone(plan.files.find((file) => file.path === SIBLING)?.content ?? '')).toBe(true);
    // One index entry for the survivor, none for the sibling.
    expect(Object.values(plan.index.items).map((item) => item.path)).toEqual([MAIN]);
    expect(plan.files.map((file) => file.path)).toContain(indexPath());
    expect(plan.message).toBe('conflict: keep-mine ' + MAIN);
  });

  it('TC-P4-U02 keep-remote leaves the original path alone and archives our version', async () => {
    const { mainText, siblingText } = await fixtures();
    const plan = await planConflictResolution({ path: MAIN, conflictPath: SIBLING, action: 'keep-remote' }, deps(mainText, siblingText).deps);

    // The survivor is already at the main path: it must not be rewritten.
    expect(plan.files.some((file) => file.path === MAIN)).toBe(false);
    expect(plan.files.find((file) => file.path === plan.archivedPath)?.content).toBe(siblingText);
    expect(isTombstone(plan.files.find((file) => file.path === SIBLING)?.content ?? '')).toBe(true);
    expect(Object.values(plan.index.items)).toHaveLength(1);
    expect(Object.values(plan.index.items)[0]?.path).toBe(MAIN);
  });

  it('TC-P4-I02 a version that vanished is an error, not a guess', async () => {
    const { siblingText } = await fixtures();
    await expect(
      planConflictResolution({ path: MAIN, conflictPath: SIBLING, action: 'keep-mine' }, deps(null, siblingText).deps),
    ).rejects.toThrow(/no longer in the repository/u);
  });

  it('TC-P4-U01 dropping an unknown path is a no-op, not a new object', () => {
    const index = indexWith();
    expect(dropIndexItemsAtPath(index, 'nowhere.md')).toBe(index);
  });
});

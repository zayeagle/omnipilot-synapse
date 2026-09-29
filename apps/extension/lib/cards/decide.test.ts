import { describe, expect, it } from 'vitest';
import type { KnowledgeCard } from '../core/ckf';
import { indexPath } from '../core/paths';
import { transparentCodec } from '../store/codec';
import type { IndexFile } from '../store/tier';
import type { RepoFile } from '../store/types';
import { TOMBSTONE_MARKER, applyCardPatch, archivePathFor, dropIndexItem, isTombstone, planCardDecision } from './decide';

/**
 * TC-P3-U01…U04 — the rules of a card decision, where they can be checked exactly.
 *
 * The interesting assertions are about what the user is left with: the surviving path, the signpost at the old
 * one, the manifest agreeing with the disk, and the archive keeping what was discarded.
 */

const AT = '2026-09-29T12:00:00.000Z';

function card(overrides: Partial<KnowledgeCard> = {}): KnowledgeCard {
  return {
    id: 'c1',
    kind: 'card',
    source_id: 's1',
    title: 'Note one',
    summary: 'short',
    points: ['p1'],
    tags: ['t'],
    evidence_paths: ['inbox/2026/09/x.md'],
    status: 'pending',
    ...overrides,
  };
}

const PENDING_PATH = 'cards/pending/note-one-c1.md';
const SHARD: RepoFile = { path: 'search/no.json', content: '{"schema":1,"terms":{}}' };

function indexWith(entryPath: string): IndexFile {
  return {
    schema: 1,
    items: {
      c1: { id: 'c1', kind: 'card', path: entryPath, created_at: AT, updated_at: AT, content_key: 'ck1' },
    },
  };
}

function deps(index = indexWith(PENDING_PATH)) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      codec: transparentCodec,
      index,
      prefix: null,
      now: () => Date.parse(AT),
      shards: {
        change: async () => {
          calls.push('change');
          return [SHARD];
        },
        remove: async () => {
          calls.push('remove');
          return [SHARD];
        },
      },
    },
  };
}

describe('card decision (F3 UNIT)', () => {
  it('TC-P3-U01 accept moves the card to its confirmed path and signs the old one', async () => {
    const plan = await planCardDecision({ card: card(), path: PENDING_PATH, action: 'accept' }, deps().deps);

    expect(plan.card?.status).toBe('confirmed');
    expect(plan.path).toBe('cards/note-one-c1.md');
    const paths = plan.files.map((file) => file.path);
    expect(paths).toContain('cards/note-one-c1.md');
    expect(paths).toContain(indexPath());
    expect(paths).toContain(SHARD.path);
    expect(paths).toContain(PENDING_PATH);
    // The manifest now points at the confirmed path: disk and index cannot disagree.
    expect(plan.index.items['c1']?.path).toBe('cards/note-one-c1.md');
    // The old location is a signpost, not a copy of the note.
    const signpost = plan.files.find((file) => file.path === PENDING_PATH)?.content ?? '';
    expect(isTombstone(signpost)).toBe(true);
    expect(signpost).toContain('cards/note-one-c1.md');
  });

  it('TC-P3-U02 edit rewrites only the whitelisted fields and keeps the address', async () => {
    const plan = await planCardDecision(
      { card: card(), path: PENDING_PATH, action: 'edit', patch: { summary: 'mine', points: ['a', 'b'], tags: [] } },
      deps().deps,
    );

    expect(plan.card?.status).toBe('pending');
    expect(plan.path).toBe(PENDING_PATH);
    expect(plan.card).toMatchObject({ summary: 'mine', points: ['a', 'b'], tags: [], source_id: 's1' });
    expect(plan.files.some((file) => isTombstone(file.content))).toBe(false);
  });

  it('TC-P3-U02 a title edit moves the file and signs the old address', async () => {
    const plan = await planCardDecision(
      { card: card(), path: PENDING_PATH, action: 'edit', patch: { title: 'Renamed' } },
      deps().deps,
    );
    expect(plan.path).toBe('cards/pending/renamed-c1.md');
    expect(plan.files.some((file) => file.path === PENDING_PATH && isTombstone(file.content))).toBe(true);
  });

  it('TC-P3-U03 discard archives the body, signs the address and drops the index entry', async () => {
    const plan = await planCardDecision({ card: card(), path: PENDING_PATH, action: 'discard' }, deps().deps);

    expect(plan.card).toBeNull();
    expect(plan.archivedPath).toBe('archive/cards/' + PENDING_PATH);
    const archived = plan.files.find((file) => file.path === plan.archivedPath)?.content ?? '';
    expect(archived).toContain('Note one');
    expect(archived).not.toContain(TOMBSTONE_MARKER);
    expect(isTombstone(plan.files.find((file) => file.path === PENDING_PATH)?.content ?? '')).toBe(true);
    expect(plan.index.items['c1']).toBeUndefined();
    expect(plan.files.map((file) => file.path)).toContain(SHARD.path);
    expect(plan.message).toBe('card: discard c1');
  });

  it('TC-P3-U04 the helpers refuse to invent fields or lose an entry silently', () => {
    const patched = applyCardPatch(card(), { title: 'x' } as never);
    expect(patched).toMatchObject({ title: 'x', id: 'c1', status: 'pending', source_id: 's1' });
    expect(archivePathFor('cards/pending/a.md')).toBe('archive/cards/cards/pending/a.md');
    const index = indexWith(PENDING_PATH);
    expect(dropIndexItem(index, 'nope')).toBe(index);
    expect(Object.keys(dropIndexItem(index, 'c1').items)).toEqual([]);
    expect(isTombstone('note')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import {
  CONFLICT_INFIX,
  conflictPathFor,
  conflictStamp,
  describePlan,
  isNoopPlan,
  planMerge,
  type PathChange,
} from './reconcile';

/** 2026-07-09T14:30:00Z */
const AT = Date.UTC(2026, 6, 9, 14, 30, 0);
const now = (): number => AT;

function change(path: string, kind: PathChange['kind']): PathChange {
  return { path, kind };
}

describe('merge planning (F3 UNIT)', () => {
  it('TC-F3-U01 plans nothing when neither side changed', () => {
    const plan = planMerge({ local: [], remote: [], now });
    expect(plan).toEqual({ pull: [], push: [], removeLocal: [], resurrect: [], conflicts: [] });
    expect(isNoopPlan(plan)).toBe(true);
    expect(describePlan(plan)).toBe('pull=0 push=0 drop=0 resurrect=0 conflicts=0');
  });

  it('TC-F3-U02 pulls a remote-only change and pushes nothing', () => {
    const plan = planMerge({
      local: [],
      remote: [change('inbox/2026/07/a.md', 'added'), change('inbox/2026/07/b.md', 'modified')],
      now,
    });
    expect(plan.pull).toEqual(['inbox/2026/07/a.md', 'inbox/2026/07/b.md']);
    expect(plan.push).toEqual([]);
    expect(plan.conflicts).toEqual([]);
    expect(isNoopPlan(plan)).toBe(false);
  });

  it('TC-F3-U03 pushes a local-only change and pulls nothing', () => {
    const plan = planMerge({ local: [change('inbox/2026/07/mine.md', 'added')], remote: [], now });
    expect(plan.pull).toEqual([]);
    expect(plan.push).toEqual(['inbox/2026/07/mine.md']);
  });

  it('TC-F3-U04 merges both sides when they touched different paths', () => {
    const plan = planMerge({
      local: [change('inbox/2026/07/mine.md', 'added')],
      remote: [change('cards/pending/theirs.md', 'modified')],
      now,
    });
    expect(plan.pull).toEqual(['cards/pending/theirs.md']);
    expect(plan.push).toEqual(['inbox/2026/07/mine.md']);
    expect(plan.conflicts).toEqual([]);
  });

  it('TC-F3-U05 keeps both versions when the same path changed on both sides', () => {
    const path = 'inbox/2026/07/note-abc123.md';
    const plan = planMerge({
      local: [change(path, 'modified')],
      remote: [change(path, 'modified')],
      now,
    });

    // The remote version keeps the original path and is pulled…
    expect(plan.pull).toEqual([path]);
    expect(plan.conflicts).toEqual([
      { path, conflictPath: `inbox/2026/07/note-abc123${CONFLICT_INFIX}202607091430.md` },
    ]);
    // …and ours is pushed beside it, so nothing is lost.
    expect(plan.push).toEqual([`inbox/2026/07/note-abc123${CONFLICT_INFIX}202607091430.md`]);
  });

  it('TC-F3-U06 resurrects a locally changed note that the remote deleted', () => {
    const plan = planMerge({
      local: [change('inbox/2026/07/mine.md', 'modified')],
      remote: [change('inbox/2026/07/mine.md', 'deleted')],
      now,
    });
    expect(plan.resurrect).toEqual(['inbox/2026/07/mine.md']);
    expect(plan.push).toEqual(['inbox/2026/07/mine.md']);
    expect(plan.removeLocal).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it('TC-F3-U06 drops a remote deletion we did not touch', () => {
    const plan = planMerge({
      local: [],
      remote: [change('inbox/2026/07/gone.md', 'deleted')],
      now,
    });
    expect(plan.removeLocal).toEqual(['inbox/2026/07/gone.md']);
    expect(plan.pull).toEqual([]);
    expect(plan.push).toEqual([]);
  });

  it('TC-F3-U07 gives simultaneous conflicts distinct, stamped names', () => {
    const plan = planMerge({
      local: [
        change('inbox/2026/07/a.md', 'modified'),
        change('inbox/2026/07/b.md', 'modified'),
        change('inbox/2026/07/c.md', 'modified'),
      ],
      remote: [
        change('inbox/2026/07/a.md', 'modified'),
        change('inbox/2026/07/b.md', 'modified'),
        change('inbox/2026/07/c.md', 'modified'),
      ],
      now,
    });

    const names = plan.conflicts.map((conflict) => conflict.conflictPath);
    expect(names).toEqual([
      'inbox/2026/07/a.conflict-202607091430.md',
      'inbox/2026/07/b.conflict-202607091430.md',
      'inbox/2026/07/c.conflict-202607091430.md',
    ]);
    // Distinct stems already keep them apart; the counter exists for a genuine collision.
    expect(new Set(names).size).toBe(3);
    expect(names.every((name) => name.includes('202607091430'))).toBe(true);
  });

  it('TC-F3-U07 never overwrites a path that already exists', () => {
    // A real note already sits exactly where the first conflict copy would go.
    const collision = 'inbox/2026/07/note-abc123.conflict-202607091430.md';
    const plan = planMerge({
      local: [change('inbox/2026/07/note-abc123.md', 'modified'), change(collision, 'added')],
      remote: [change('inbox/2026/07/note-abc123.md', 'modified')],
      now,
    });
    expect(plan.conflicts[0]?.conflictPath).toBe(
      'inbox/2026/07/note-abc123.conflict-202607091430-2.md',
    );
  });

  it('TC-F3-U04 never emits the same path twice across buckets', () => {
    const plan = planMerge({
      local: [change('x.md', 'modified'), change('y.md', 'added'), change('y.md', 'added')],
      remote: [change('x.md', 'modified'), change('z.md', 'added')],
      now,
    });
    for (const bucket of [plan.pull, plan.push, plan.removeLocal, plan.resurrect]) {
      expect(new Set(bucket).size).toBe(bucket.length);
    }
    // A locally duplicated entry is coalesced, not planned twice.
    expect(plan.push.filter((path) => path === 'y.md')).toHaveLength(1);
  });

  it('TC-F3-U03 does not push a local deletion (notes are archived, never destroyed)', () => {
    const plan = planMerge({
      local: [change('inbox/2026/07/removed-locally.md', 'deleted')],
      remote: [],
      now,
    });
    expect(plan.push).toEqual([]);
    expect(isNoopPlan(plan)).toBe(true);
  });
});

describe('conflict naming (F3 UNIT)', () => {
  it('TC-F3-U05 inserts the marker before the extension and preserves the directory', () => {
    expect(conflictPathFor('inbox/2026/07/note-abc.md', '202607091430')).toBe(
      'inbox/2026/07/note-abc.conflict-202607091430.md',
    );
    expect(conflictPathFor('cards/pending/x.md.enc', '202607091430')).toBe(
      'cards/pending/x.md.conflict-202607091430.enc',
    );
  });

  it('TC-F3-U05 handles a path with no directory and no extension', () => {
    expect(conflictPathFor('NOTES', '202607091430')).toBe('NOTES.conflict-202607091430');
    expect(conflictPathFor('a/b/', '202607091430')).toBe('a/b/.conflict-202607091430');
  });

  it('TC-F3-U05 formats the stamp in UTC with minute resolution', () => {
    expect(conflictStamp(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('202601020304');
    expect(conflictStamp(AT)).toBe('202607091430');
  });
});

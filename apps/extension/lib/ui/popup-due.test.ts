import { describe, expect, it } from 'vitest';
import { dueRows } from '../../entrypoints/popup/due';

/**
 * TC-P7-U03 — the queue projection, where the rule is "render what the worker said, invent nothing".
 *
 * The popup is the one place these numbers become pixels, so the arithmetic (days overdue) is checked here rather
 * than in DOM code, and the tolerance is checked for the same reason it exists: an unexpected reply must degrade to
 * an empty queue, never to a broken popup.
 */
describe('review queue projection (F7 UNIT)', () => {
  it('TC-P7-U03 turns a queue reply into rows, in days', () => {
    const rows = dueRows({
      due: [
        { id: 'a', path: 'inbox/2026/09/a.md', title: 'a.md', overdueMs: 4 * 24 * 60 * 60 * 1000 },
        { id: 'b', path: 'inbox/2026/09/b.md', title: '', overdueMs: 0 },
      ],
    });
    expect(rows).toEqual([
      { id: 'a', label: 'a.md', overdueDays: 4 },
      { id: 'b', label: 'inbox/2026/09/b.md', overdueDays: 0 },
    ]);
  });

  it('TC-P7-U03 an unexpected reply yields no rows, and a due note without a path is still actionable', () => {
    expect(dueRows(null)).toEqual([]);
    expect(dueRows('nonsense')).toEqual([]);
    expect(dueRows({})).toEqual([]);
    expect(dueRows({ due: 'not an array' })).toEqual([]);
    // Junk entries are dropped…
    expect(dueRows({ due: [null, 'x', { path: 'no-id.md' }] })).toEqual([]);
    // …but a due note with no path keeps its id: the fact that it is due is what the user acts on.
    expect(dueRows({ due: [{ id: 'c' }] })).toEqual([{ id: 'c', label: '', overdueDays: 0 }]);
    // A negative or non-numeric overdue is clamped rather than rendered as nonsense.
    expect(dueRows({ due: [{ id: 'd', overdueMs: -5 }] })[0]?.overdueDays).toBe(0);
    expect(dueRows({ due: [{ id: 'e', overdueMs: 'soon' }] })[0]?.overdueDays).toBe(0);
  });
});

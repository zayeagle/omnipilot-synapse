import { describe, expect, it } from 'vitest';
import { dueForReview, parseReviewFile, recallHint, suggestTopic, type InsightDocument } from './insights';

/**
 * TC-P7-U01…U03 — the local suggestions, where being right matters more than being clever.
 *
 * Every test here is really about one of two things: that a suggestion says **why** it is being made, and that
 * the functions **prefer saying nothing** over guessing. Those are the properties that decide whether a user keeps
 * the feature on.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-29T12:00:00.000Z');

function document(overrides: Partial<InsightDocument> = {}): InsightDocument {
  return { id: 'd1', path: 'inbox/2026/09/a.md', title: 'A', tags: [], terms: [], ...overrides };
}

describe('local recall hint (F7 UNIT)', () => {
  it('TC-P7-U01 an identical URL is the same page, and says so', () => {
    const hit = recallHint(
      { url: 'https://example.test/a' },
      [document({ url: 'https://example.test/a' }), document({ id: 'd2', url: 'https://example.test/b' })],
    );
    expect(hit).toMatchObject({ id: 'd1', reason: 'same-url' });
  });

  it('TC-P7-U01 a content fingerprint beats a shared tag, and weak overlap says nothing', () => {
    const byContent = recallHint(
      { contentKey: 'ck1', tags: ['x'] },
      [document({ contentKey: 'ck1', tags: ['x'] })],
    );
    expect(byContent?.reason).toBe('same-content');

    // Two shared terms is not evidence at this threshold → no suggestion at all.
    expect(recallHint({ terms: ['a', 'b'] }, [document({ terms: ['a', 'b'] })])).toBeNull();
    expect(
      recallHint({ terms: ['a', 'b', 'c'] }, [document({ terms: ['a', 'b', 'c'] })])?.reason,
    ).toBe('shared-terms');
  });
});

describe('local topic suggestion (F7 UNIT)', () => {
  it('TC-P7-U02 suggests the strongest topic with the terms it matched on', () => {
    const suggestion = suggestTopic(
      { terms: ['memory', 'spacing', 'recall'] },
      [
        { id: 't1', name: 'Memory', terms: ['memory', 'spacing', 'recall'] },
        { id: 't2', name: 'Gardening', terms: ['soil', 'seed'] },
      ],
    );
    expect(suggestion).toMatchObject({ id: 't1', name: 'Memory' });
    expect(suggestion?.matchedTerms).toEqual(['memory', 'spacing', 'recall']);
  });

  it('TC-P7-U02 a tie or a weak match produces no suggestion, never a coin flip', () => {
    expect(
      suggestTopic(
        { terms: ['a', 'b'] },
        [
          { id: 't1', name: 'One', terms: ['a', 'b'] },
          { id: 't2', name: 'Two', terms: ['a', 'b'] },
        ],
      ),
    ).toBeNull();
    expect(suggestTopic({ terms: ['a'] }, [{ id: 't1', name: 'One', terms: ['a'] }])).toBeNull();
  });
});

describe('local review queue (F7 UNIT)', () => {
  it('TC-P7-U03 orders by how overdue a note is, and leaves the not-yet-due ones out', () => {
    const iso = (offsetDays: number): string => new Date(NOW + offsetDays * DAY).toISOString();
    const due = dueForReview(
      [
        { id: 'fresh', path: 'a', title: 'Fresh', next_review_at: iso(3) },
        { id: 'late', path: 'b', title: 'Late', next_review_at: iso(-4) },
        { id: 'later', path: 'c', title: 'Later', next_review_at: iso(-1) },
      ],
      NOW,
    );
    expect(due.map((entry) => entry.id)).toEqual(['late', 'later']);
    expect(due[0]?.overdueMs).toBe(4 * DAY);
  });

  it('TC-P7-U03 an unscheduled or unreadable entry is due now, never dropped', () => {
    const due = dueForReview(
      [
        // A card accepted this second: the record exists, the schedule does not.
        { id: 'new', path: 'a', title: 'New', next_review_at: null },
        { id: 'broken', path: 'b', title: 'Broken', next_review_at: 'not-a-date' },
      ],
      NOW,
    );
    expect(due.map((entry) => entry.id).sort()).toEqual(['broken', 'new']);
    expect(due.every((entry) => entry.overdueMs === 0)).toBe(true);
  });
});

describe('review file reader (F7 UNIT)', () => {
  it('TC-P7-U03 reads the canonical container and drops entries that are not review records', () => {
    const file = JSON.stringify({
      schema: 1,
      items: {
        a: { id: 'a', kind: 'review', next_review_at: '2026-09-01T00:00:00.000Z', use_count: 2 },
        b: { id: 'b', kind: 'card', title: 'not a review entry' },
      },
    });
    expect(parseReviewFile(file)).toEqual([
      { id: 'a', next_review_at: '2026-09-01T00:00:00.000Z', use_count: 2 },
    ]);
  });

  it('TC-P7-U03 an unreadable or foreign file yields an empty queue, never an exception', () => {
    expect(parseReviewFile(null)).toEqual([]);
    expect(parseReviewFile('not json')).toEqual([]);
    expect(parseReviewFile('[1,2,3]')).toEqual([]);
    // A bare id→record map (the shape before the container was defined) still reads.
    expect(
      parseReviewFile(JSON.stringify({ z: { id: 'z', kind: 'review', next_review_at: null } })),
    ).toEqual([{ id: 'z', next_review_at: null }]);
  });
});

/**
 * TC-F3-U01…U06 — the popup's 待处理 projection (F3 / P0-1).
 *
 * The projection is pure on purpose. `cards.list` is answered by a worker written in parallel, so the only
 * interesting questions are what the popup does with a half-built reply — and the one rule that must never
 * bend: a proposal the user still has to decide about is shown, never silently dropped (W2 / W6).
 */

import { describe, expect, it } from 'vitest';

import {
  cardPatchFor,
  decisionResult,
  pendingCardRows,
  PENDING_LIMIT,
} from '../../entrypoints/popup/pending';

function card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c1',
    path: 'cards/pending/c1.md',
    title: '间隔复习',
    summary: '间隔比时长重要。',
    points: ['先自评再排期'],
    tags: ['记忆'],
    evidence_paths: ['inbox/2026/paper.md'],
    created_at: '2026-07-09T08:00:00.000Z',
    ...overrides,
  };
}

describe('popup 待处理 projection (F3 UNIT)', () => {
  it('TC-F3-U01 keeps exactly the fields the row renders', () => {
    const rows = pendingCardRows({ cards: [card()] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'c1',
      path: 'cards/pending/c1.md',
      unreadable: false,
      title: '间隔复习',
      summary: '间隔比时长重要。',
      points: ['先自评再排期'],
      tags: ['记忆'],
      source: 'inbox/2026/paper.md',
      createdAt: '2026-07-09T08:00:00.000Z',
      hiddenPoints: 0,
    });
  });

  it('TC-F3-U02 truncates points and tags but reports how many it hid', () => {
    const eight = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const rows = pendingCardRows({ cards: [card({ points: eight })] });
    expect(rows[0]?.points).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(rows[0]?.hiddenPoints).toBe(3);
    // Non-string / blank entries are not points, so they do not inflate the count either.
    expect(pendingCardRows({ cards: [card({ points: ['a', '', 7, 'b'] })] })[0]?.hiddenPoints).toBe(0);
    expect(pendingCardRows({ cards: [card({ tags: ['t1', '', 't2'] })] })[0]?.tags).toEqual(['t1', 't2']);
  });

  it('TC-F3-U03 shows an unreadable proposal instead of dropping it', () => {
    const rows = pendingCardRows({
      cards: [card({ id: 'c2', path: 'cards/pending/c2.md', unreadable: true, title: 'HIDDEN' })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.unreadable).toBe(true);
    expect(rows[0]?.path).toBe('cards/pending/c2.md');
    // Whatever the reply happened to carry alongside the flag is not rendered as if it were readable content.
    expect(rows[0]?.title).toBe('');
    expect(rows[0]?.summary).toBe('');
  });

  it('TC-F3-U04 survives a malformed reply and skips only what cannot be decided', () => {
    expect(pendingCardRows(null)).toEqual([]);
    expect(pendingCardRows({ cards: 'nope' })).toEqual([]);
    expect(pendingCardRows({ cards: [null, 7, {}] })).toEqual([]);
    // No id or no path means neither the index nor the file can be addressed, so there is nothing to send.
    expect(pendingCardRows({ cards: [{ path: 'cards/pending/x.md' }] })).toEqual([]);
    expect(pendingCardRows({ cards: [{ id: 'x' }] })).toEqual([]);
    // Non-string content never becomes a row field.
    const rows = pendingCardRows({ cards: [card({ title: 42, summary: null, evidence_paths: 'nope' })] });
    expect(rows[0]?.title).toBe('');
    expect(rows[0]?.summary).toBe('');
    expect(rows[0]?.source).toBe('');
  });

  it('TC-F3-U04 respects the render limit even if the worker sends more', () => {
    const many = Array.from({ length: PENDING_LIMIT + 5 }, (_value, index) =>
      card({ id: `c${index}`, path: `cards/pending/c${index}.md` }),
    );
    expect(pendingCardRows({ cards: many })).toHaveLength(PENDING_LIMIT);
  });

  it('TC-F3-U05 builds a patch with only the fields the human changed', () => {
    const row = pendingCardRows({ cards: [card()] })[0];
    expect(row).toBeDefined();
    if (!row) return;

    // Untouched — including the whitespace the text field may add — is not a change, so nothing is committed.
    expect(cardPatchFor(row, '间隔复习', '间隔比时长重要。')).toBeNull();
    expect(cardPatchFor(row, '  间隔复习  ', '间隔比时长重要。')).toBeNull();
    expect(cardPatchFor(row, '间隔复习（改）', '间隔比时长重要。')).toEqual({ title: '间隔复习（改）' });
    expect(cardPatchFor(row, '间隔复习', '')).toEqual({ summary: '' });
    expect(cardPatchFor(row, '标题', '摘要')).toEqual({ title: '标题', summary: '摘要' });
  });

  it('TC-F3-U06 reads the two paths a decision may report and ignores anything else', () => {
    expect(decisionResult({ action: 'accept', path: 'cards/c1.md', previousPath: 'cards/pending/c1.md' })).toEqual({
      path: 'cards/c1.md',
      archivedPath: '',
    });
    expect(decisionResult({ action: 'discard', archivedPath: 'archive/cards/cards/pending/c1.md' })).toEqual({
      path: '',
      archivedPath: 'archive/cards/cards/pending/c1.md',
    });
    expect(decisionResult({ action: 'accept', path: 42 })).toEqual({ path: '', archivedPath: '' });
    expect(decisionResult(undefined)).toEqual({ path: '', archivedPath: '' });
  });
});

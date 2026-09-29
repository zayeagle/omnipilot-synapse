/**
 * Projection for the review queue (F7 / G10).
 *
 * Pure, for the same reason `pending.ts` is: the popup must be able to render **untrusted** data without the
 * render code doing arithmetic or trusting shapes. A reply that is not a queue yields an empty queue — never a
 * crash and never a fabricated row.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DueRow {
  id: string;
  /** What the user recognises the note by. The index carries no title, so a path is a legitimate label. */
  label: string;
  /** Whole days overdue; 0 means "due today" — the wording is the surface's business, not this module's. */
  overdueDays: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * `review.due` reply → rows.
 *
 * Tolerant on purpose: a missing `due` array, a non-object entry or a missing id is dropped rather than
 * rendered as a blank row. But an entry the worker marked due is **kept even without a path**, because "a note is
 * due" is the fact the user acts on — an unlabelled one is still actionable (the id identifies it).
 */
export function dueRows(value: unknown): DueRow[] {
  const raw = asRecord(value)?.['due'];
  if (!Array.isArray(raw)) return [];
  const rows: DueRow[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (record === null) continue;
    const id = typeof record['id'] === 'string' ? record['id'] : '';
    if (id.length === 0) continue;
    const path = typeof record['path'] === 'string' ? record['path'] : '';
    const title = typeof record['title'] === 'string' ? record['title'] : '';
    const overdueMs = typeof record['overdueMs'] === 'number' && Number.isFinite(record['overdueMs'])
      ? Math.max(0, record['overdueMs'])
      : 0;
    rows.push({ id, label: title.length > 0 ? title : path, overdueDays: Math.floor(overdueMs / DAY_MS) });
  }
  return rows;
}

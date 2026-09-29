/**
 * The 待处理 (pending) projection for the popup.
 *
 * Pure functions, no DOM: `cards.list` is answered by a worker that is written in parallel, so the popup
 * never trusts a field of the reply. It projects the response into the handful of things it is willing to
 * render and — the load-bearing rule — **drops nothing the user still has to decide about**: a proposal whose
 * body could not be read is shown as exactly that, never silently skipped (W2 / W6).
 *
 * The three decisions themselves belong to the worker (`lib/cards/decide.ts`); the popup only carries the
 * human's choice there, and only after the human pressed something (E1/E2).
 */

import type { CardPatch } from '../../lib/messages';

/** How many pending cards the popup asks for and is willing to render. */
export const PENDING_LIMIT = 20;

/** Compactness caps: the popup is 400 px wide, not a reading surface. */
const MAX_POINTS = 5;
const MAX_TAGS = 8;
/** Matches the `card.decide` patch limit in `lib/messages.ts`, so the UI can never build a rejected patch. */
const MAX_TEXT = 2_000;
const MAX_TITLE = 300;
const MAX_PATH = 1_000;

export interface PendingCardRow {
  id: string;
  path: string;
  /** The body could not be read (locked vault, corrupt record): the proposal exists, its content does not. */
  unreadable: boolean;
  title: string;
  summary: string;
  points: string[];
  tags: string[];
  /** `evidence_paths[0]` — a repository path. The popup invents no URL scheme for it. */
  source: string;
  createdAt: string;
  /** Points the caps hid, so the row can say "还有 N 条" instead of pretending the list is complete. */
  hiddenPoints: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function strings(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const item = text(entry, 500);
    if (item.length > 0) out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

/** How many entries the raw array actually held, so truncation stays visible. */
function countStrings(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).length;
}

/**
 * Project a `cards.list` reply into rows.
 *
 * An entry without both an id and a path cannot be decided about (the worker keys the index by id and the
 * file by path), so it is skipped — that is the one honest drop. Everything else survives, unreadable included.
 */
export function pendingCardRows(data: unknown, limit = PENDING_LIMIT): PendingCardRow[] {
  const root = asRecord(data);
  const raw = root !== null && Array.isArray(root['cards']) ? root['cards'] : [];
  const rows: PendingCardRow[] = [];
  for (const entry of raw) {
    if (rows.length >= limit) break;
    const record = asRecord(entry);
    if (record === null) continue;
    const id = text(record['id'], 200);
    const path = text(record['path'], MAX_PATH);
    if (id.length === 0 || path.length === 0) continue;
    const unreadable = record['unreadable'] === true;
    const points = unreadable ? [] : strings(record['points'], MAX_POINTS);
    rows.push({
      id,
      path,
      unreadable,
      title: unreadable ? '' : text(record['title'], MAX_TITLE),
      summary: unreadable ? '' : text(record['summary'], MAX_TEXT),
      points,
      tags: unreadable ? [] : strings(record['tags'], MAX_TAGS),
      source: unreadable ? '' : strings(record['evidence_paths'], 1)[0] ?? '',
      createdAt: text(record['created_at'], 40),
      hiddenPoints: unreadable ? 0 : Math.max(0, countStrings(record['points']) - points.length),
    });
  }
  return rows;
}

/**
 * The patch for a rewrite: **only what the human actually changed**, or `null` when nothing did.
 *
 * `null` is meaningful — the popup must not commit a no-op edit, because an empty edit would still write a new
 * revision of the card the AI produced (E2: the human's text stays the AI's until the human changes it).
 */
export function cardPatchFor(row: PendingCardRow, title: string, summary: string): CardPatch | null {
  const patch: CardPatch = {};
  const nextTitle = title.trim();
  const nextSummary = summary.trim();
  if (nextTitle !== row.title) patch.title = nextTitle.slice(0, MAX_TEXT);
  if (nextSummary !== row.summary) patch.summary = nextSummary.slice(0, MAX_TEXT);
  return Object.keys(patch).length === 0 ? null : patch;
}

export interface CardDecisionResult {
  /** Where the surviving card lives ('' when it was discarded). */
  path: string;
  /** Where the body was archived (discard only). */
  archivedPath: string;
}

/** Read only the two paths a `card.decide` reply may carry; anything else is ignored, not rendered. */
export function decisionResult(data: unknown): CardDecisionResult {
  const record = asRecord(data);
  return {
    path: record === null ? '' : text(record['path'], MAX_PATH),
    archivedPath: record === null ? '' : text(record['archivedPath'], MAX_PATH),
  };
}

/**
 * `NOTES.md` — the human-readable catalogue of the knowledge base.
 *
 * PURE MODULE: no browser, DOM, network or clock access, so the same records always render the same
 * bytes. That is not a stylistic choice: the file is committed, and `catalogueHash` is what lets a
 * caller skip the write entirely when nothing changed (04-design F4 step 4, TC-F4-U11).
 *
 * Deliberately **no "generated at" line**: a wall-clock timestamp would change the output on every
 * render, so the hash guard could never fire and every capture would add commit noise. The catalogue
 * reports the *records'* timestamps instead, which are stable and more informative.
 */

import { type CkfRecord, type KnowledgeCard, type SourceItem, type Topic } from '../core/ckf';
import { contentKey } from '../core/dedup';
import { cardPath, joinPath, normalizePrefix, sourceItemPath, topicPath } from '../core/paths';
import { compareText } from './tokenize';

export const NOTES_FILE_NAME = 'NOTES.md';

/** Sections that list at most this many entries before summarising the rest. */
export const DEFAULT_MAX_RECENT_CARDS = 10;
export const DEFAULT_MAX_INBOX = 20;

export function notesPath(prefix?: string | null): string {
  return joinPath(normalizePrefix(prefix), NOTES_FILE_NAME);
}

export interface NotesIndexInput {
  records: readonly CkfRecord[];
  /** Repository path prefix, so the links match the real layout of this store. */
  prefix?: string | null;
  maxRecentCards?: number;
  maxInbox?: number;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Inline Markdown escaping: a title must never be able to break the document it is listed in. */
function escapeInline(text: string): string {
  return text
    .replace(/\\/gu, '\\\\')
    .replace(/([[\]`|])/gu, '\\$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

function dayOf(isoTimestamp: string): string {
  return isoTimestamp.length >= 10 ? isoTimestamp.slice(0, 10) : '';
}

/** ISO-8601 UTC strings sort chronologically as text; ties fall back to the id. */
function byNewest<T extends { id: string }>(at: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const order = compareText(at(b), at(a));
    return order !== 0 ? order : compareText(a.id, b.id);
  };
}

function bullet(title: string, path: string, suffix: string): string {
  return `- [${escapeInline(title)}](${path})${suffix}`;
}

function isSource(record: CkfRecord): record is SourceItem {
  return record.kind === 'source';
}

function isCard(record: CkfRecord): record is KnowledgeCard {
  return record.kind === 'card';
}

function isTopic(record: CkfRecord): record is Topic {
  return record.kind === 'topic';
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/**
 * Render the catalogue.
 *
 * Four sections, in the order a reader wants them: how the repository is laid out, what the topics
 * are, what is new, and what still has to be distilled.
 */
export function renderNotesIndex(input: NotesIndexInput): string {
  const maxRecent = input.maxRecentCards ?? DEFAULT_MAX_RECENT_CARDS;
  const maxInbox = input.maxInbox ?? DEFAULT_MAX_INBOX;
  const base = normalizePrefix(input.prefix);
  const link = (path: string): string => (base === '' ? path : `${base}/${path}`);

  const records = [...input.records];
  const sources = records.filter(isSource);
  const cards = records.filter(isCard);
  const topics = records.filter(isTopic);

  const cardsByTopic = new Map<string, number>();
  for (const card of cards) {
    const key = card.topic_id ?? '';
    cardsByTopic.set(key, (cardsByTopic.get(key) ?? 0) + 1);
  }
  const topicNames = new Map(topics.map((topic) => [topic.id, topic.name]));

  const rows: Array<{ label: string; count: number; topic: Topic | null }> = topics.map((topic) => ({
    label: topic.name,
    count: cardsByTopic.get(topic.id) ?? 0,
    topic,
  }));
  for (const [id, count] of cardsByTopic) {
    if (id === '' || topicNames.has(id)) continue;
    rows.push({ label: `(unknown topic: ${id})`, count, topic: null });
  }
  if (cardsByTopic.has('')) {
    rows.push({ label: '(no topic)', count: cardsByTopic.get('') ?? 0, topic: null });
  }
  // Most-used topics first, then by name: a reader scans this table, and the order is total.
  rows.sort((a, b) => (b.count !== a.count ? b.count - a.count : compareText(a.label, b.label)));

  const lines: string[] = [];
  lines.push('# Knowledge catalogue');
  lines.push('');
  lines.push(
    `${sources.length} source(s), ${cards.length} card(s), ${topics.length} topic(s). Titles only — the records themselves are the Markdown files under the paths below.`,
  );
  lines.push('');
  lines.push(
    'This file and `search/` are derived: both are rebuilt from the records at any time, so neither has to be merged by hand.',
  );
  lines.push('');

  lines.push('## Layout');
  lines.push('');
  lines.push('| Path | Contents |');
  lines.push('| --- | --- |');
  lines.push(`| \`${link('inbox/YYYY/MM/')}\` | Captured sources, one Markdown file per page |`);
  lines.push(`| \`${link('cards/pending/')}\` | Distilled cards waiting for confirmation |`);
  lines.push(`| \`${link('cards/')}\` | Confirmed cards |`);
  lines.push(`| \`${link('topics/')}\` | Topic definitions |`);
  lines.push(`| \`${link('review/state.json')}\` | Spaced-repetition state |`);
  lines.push(`| \`${link('search/')}\` | Postings shards — rebuildable, safe to delete |`);
  lines.push(`| \`${link('index.json')}\` | Machine-readable catalogue |`);
  lines.push(`| \`${link(NOTES_FILE_NAME)}\` | This file |`);
  lines.push('');

  lines.push('## Topics');
  lines.push('');
  if (rows.length === 0) {
    lines.push('_No topics yet._');
  } else {
    lines.push('| Topic | Cards |');
    lines.push('| --- | --- |');
    for (const row of rows) {
      const label =
        row.topic === null
          ? escapeInline(row.label)
          : `[${escapeInline(row.topic.name)}](${link(topicPath(row.topic))})`;
      lines.push(`| ${label} | ${row.count} |`);
    }
  }
  lines.push('');

  const recent = [...cards].sort(byNewest((card) => card.distilled_by?.at ?? ''));
  lines.push(`## Recent cards (${cards.length})`);
  lines.push('');
  if (recent.length === 0) {
    lines.push('_No cards yet — capture a page and distill it._');
  } else {
    for (const card of recent.slice(0, maxRecent)) {
      const details: string[] = [];
      const day = dayOf(card.distilled_by?.at ?? '');
      if (day !== '') details.push(day);
      if (card.topic_id !== undefined) {
        details.push(escapeInline(topicNames.get(card.topic_id) ?? card.topic_id));
      }
      lines.push(
        bullet(card.title, link(cardPath(card)), details.length === 0 ? '' : ` · ${details.join(' · ')}`),
      );
    }
    if (recent.length > maxRecent) lines.push(`- … and ${recent.length - maxRecent} more`);
  }
  lines.push('');

  const distilled = new Set(cards.map((card) => card.source_id));
  const backlog = sources
    .filter((source) => !distilled.has(source.id))
    .sort(byNewest((item) => item.captured_at));
  lines.push(`## Inbox backlog (${backlog.length})`);
  lines.push('');
  if (backlog.length === 0) {
    lines.push('_Inbox is empty — every source has been distilled._');
  } else {
    for (const source of backlog.slice(0, maxInbox)) {
      const day = dayOf(source.captured_at);
      lines.push(
        bullet(source.title, link(sourceItemPath(source)), day === '' ? '' : ` · ${day}`),
      );
    }
    if (backlog.length > maxInbox) lines.push(`- … and ${backlog.length - maxInbox} more`);
  }

  // Exactly one trailing newline, no trailing blank line: a rewritten file must not drift.
  while (lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

/**
 * Fingerprint of the rendered catalogue.
 *
 * Hashing the *output* rather than the inputs is what makes the guard exact: a change that does not
 * alter the readable file (a new review-state record, a reordered record list) does not produce a
 * commit. `contentKey` is the F1 non-cryptographic fingerprint — a commit guard needs equality, not
 * collision resistance.
 */
export function catalogueHash(input: NotesIndexInput): string {
  return contentKey(renderNotesIndex(input));
}
